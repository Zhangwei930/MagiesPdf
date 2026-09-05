'use strict';

const { randomUUID } = require('node:crypto');
const { AgentRuntime } = require('./agentRuntime.cjs');
const { AiError, OpenAiCompatibleClient } = require('./openAiClient.cjs');
const { requiresInteractiveApproval } = require('./automationPolicy.cjs');
const { strictPrivacyRefusal } = require('./privacy.cjs');
const {
  normalizeProviders,
  resolveActiveProvider,
  secretKeyForProvider,
} = require('./providerStore.cjs');

function abortError() {
  const error = new Error('AI turn cancelled');
  error.name = 'AbortError';
  return error;
}

function createAiService({
  readCatalog,
  readSettings,
  secretStore,
  executeTool,
  model = new OpenAiCompatibleClient(),
  runtimeFactory,
  externalToolProvider,
  officeToolProvider,
  webSearchProvider,
}) {
  const activeTurns = new Map();

  const getConfig = () => {
    const ai = readSettings().ai || {};
    const { providers, activeProviderId } = normalizeProviders(ai);
    const active = providers.find((provider) => provider.id === activeProviderId) ?? null;

    return {
      providers: providers.map((provider) => ({
        ...provider,
        // Whether a key exists, never the key itself.
        apiKeyConfigured: secretStore.hasSecret(secretKeyForProvider(provider.id)),
      })),
      activeProviderId,
      maxSteps: Number(ai.maxSteps) || 6,
      // The resolved view of the active provider, which is what a turn uses.
      baseUrl: active ? active.baseUrl : '',
      model: active ? active.model : '',
      apiKeyConfigured: active
        ? secretStore.hasSecret(secretKeyForProvider(active.id))
        : false,
    };
  };

  const setApiKey = (value, providerId) => {
    const ai = readSettings().ai || {};
    const { activeProviderId } = normalizeProviders(ai);
    const target = String(providerId || activeProviderId || '');
    if (!target) {
      throw new AiError('AI_CONFIG_INVALID', 'No model provider is configured', {
        zh: '请先添加一个模型服务商。',
        en: 'Add a model provider first.',
      });
    }
    secretStore.setSecret(secretKeyForProvider(target), String(value || ''));
    return {
      providerId: target,
      apiKeyConfigured: secretStore.hasSecret(secretKeyForProvider(target)),
    };
  };

  const executeTurn = async (request, sendEvent, options = {}) => {
    const requestId = String(request?.requestId || '');
    if (!requestId) throw new AiError('AI_INPUT_INVALID', 'requestId is required');
    if (activeTurns.has(requestId)) {
      throw new AiError('AI_TURN_ACTIVE', `AI turn ${requestId} is already running`);
    }

    const controller = new AbortController();
    const approvals = new Map();
    const event = (payload) => sendEvent({ requestId, ...payload });
    const interactiveApproval = (details) => new Promise((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(abortError());
        return;
      }
      const approvalId = randomUUID();
      let cleared = false;
      const clear = () => {
        if (cleared) return;
        cleared = true;
        event({ type: 'approval_cleared', approvalId });
      };
      const onAbort = () => {
        approvals.delete(approvalId);
        clear();
        reject(abortError());
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      approvals.set(approvalId, {
        settle(approved) {
          controller.signal.removeEventListener('abort', onAbort);
          clear();
          resolve(approved);
        },
      });
      event({ type: 'approval_required', approvalId, ...details });
    });

    const requestApproval = options.requestApproval || interactiveApproval;
    const createRuntime = runtimeFactory || ((deps) => new AgentRuntime({
      tools: deps.tools,
      model,
      executeTool,
      requestApproval: deps.requestApproval,
      externalToolProvider: deps.externalToolProvider,
      officeToolProvider: deps.officeToolProvider,
      // Every dependency worked out below has to arrive here. Web search was
      // computed, handed to this factory, and then dropped — so it could be
      // configured in Settings and register no tool at all, while the injected
      // factory these tests used passed it on and looked fine.
      webSearchProvider: deps.webSearchProvider,
    }));
    const runtime = createRuntime({
      requestApproval,
      tools: options.tools || readCatalog().tools,
      externalToolProvider: Object.hasOwn(options, 'externalToolProvider')
        ? options.externalToolProvider
        : externalToolProvider,
      officeToolProvider: options.officeToolProvider || officeToolProvider,
      // `hasOwn`, not `||`: an unattended turn switches this off by passing
      // undefined, and `||` would hand it the ambient provider instead —
      // which is how a rule allowing one Office tool also reached the network.
      webSearchProvider: Object.hasOwn(options, 'webSearchProvider')
        ? options.webSearchProvider
        : webSearchProvider,
    });
    activeTurns.set(requestId, { controller, approvals });

    try {
      const ai = readSettings().ai || {};
      const active = resolveActiveProvider(ai);
      const refusal = strictPrivacyRefusal({
        strict: ai.strictLocalPrivacy === true,
        baseUrl: active ? active.baseUrl : '',
      });
      if (refusal) {
        throw new AiError(refusal.code, refusal.message, refusal.userMessage);
      }
      if (!active) {
        throw new AiError('AI_CONFIG_INVALID', 'No model provider is configured', {
          zh: '请先在设置中添加并选用一个模型服务商。',
          en: 'Add a model provider in settings and select it first.',
        });
      }
      return await runtime.runTurn({
        ...request,
        config: {
          baseUrl: active.baseUrl,
          apiKey: secretStore.getSecret(secretKeyForProvider(active.id)),
          model: active.model,
          maxSteps: Number(ai.maxSteps) || 6,
          permissionMode: options.permissionMode
            || (ai.permissionMode === 'auto' || ai.permissionMode === 'observer'
              ? ai.permissionMode
              : 'confirm'),
          reasoningEffort: active.reasoningEffort || '',
        },
        signal: controller.signal,
        onEvent: event,
      });
    } finally {
      for (const approval of approvals.values()) {
        approval.settle(false);
      }
      approvals.clear();
      activeTurns.delete(requestId);
    }
  };

  const runTurn = (request, sendEvent) => executeTurn(request, sendEvent);

  const runUnattended = async (request, sendEvent) => {
    const allowedToolIds = [...new Set((Array.isArray(request?.allowedToolIds)
      ? request.allowedToolIds
      : []).map(String))];
    if (allowedToolIds.length === 0) {
      throw new AiError('AI_INPUT_INVALID', 'Unattended automation requires an allowed Office tool');
    }
    if (allowedToolIds.some((toolId) => !toolId.startsWith('office:'))) {
      throw new AiError('AI_INPUT_INVALID', 'Unattended tools must use the office: namespace');
    }
    if (allowedToolIds.some(requiresInteractiveApproval)) {
      throw new AiError('AI_INPUT_INVALID', 'This Office tool requires interactive approval');
    }
    const allowed = new Set(allowedToolIds);
    const filteredOfficeProvider = officeToolProvider && {
      async listTools(options) {
        const tools = await officeToolProvider.listTools(options);
        return tools.filter((tool) => allowed.has(tool.toolId));
      },
      callTool: (...args) => officeToolProvider.callTool(...args),
    };
    let successfulOfficeTool = false;
    const result = await executeTurn(request, (event) => {
      if (event?.type === 'tool_result' && event.ok === true
        && allowed.has(String(event.toolId || ''))) {
        successfulOfficeTool = true;
      }
      sendEvent(event);
    }, {
      tools: [],
      externalToolProvider: undefined,
      // Nothing here may reach the network. The allow-list is Office tools by
      // construction, and a rule that runs against a folder with nobody
      // watching does not get a search engine as well.
      webSearchProvider: undefined,
      officeToolProvider: filteredOfficeProvider,
      // Never the user's interactive mode. `auto` approves without asking, and
      // asking is the only thing that consults the allow-list below — so an
      // unattended turn in auto mode had no allow-list at all.
      permissionMode: 'confirm',
      requestApproval: async (details) => allowed.has(String(details?.toolId || '')),
    });
    if (!successfulOfficeTool) {
      throw new AiError('AI_AUTOMATION_NO_TOOL', 'Unattended turn did not complete a successful Office tool');
    }
    return result;
  };

  const respondApproval = (requestId, approvalId, approved) => {
    const turn = activeTurns.get(String(requestId));
    const approval = turn?.approvals.get(String(approvalId));
    if (!turn || !approval) return false;
    turn.approvals.delete(String(approvalId));
    approval.settle(approved === true);
    return true;
  };

  const cancelTurn = (requestId) => {
    const turn = activeTurns.get(String(requestId));
    if (!turn) return false;
    turn.controller.abort();
    return true;
  };

  return {
    cancelTurn,
    getConfig,
    respondApproval,
    runUnattended,
    runTurn,
    setApiKey,
  };
}

module.exports = { abortError, createAiService };
