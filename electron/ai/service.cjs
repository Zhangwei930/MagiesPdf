'use strict';

const { randomUUID } = require('node:crypto');
const { AgentRuntime } = require('./agentRuntime.cjs');
const { AiError, OpenAiCompatibleClient } = require('./openAiClient.cjs');

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
}) {
  const activeTurns = new Map();

  const getConfig = () => {
    const ai = readSettings().ai || {};
    return {
      baseUrl: String(ai.baseUrl || ''),
      model: String(ai.model || ''),
      maxSteps: Number(ai.maxSteps) || 6,
      apiKeyConfigured: secretStore.hasApiKey(),
    };
  };

  const setApiKey = (value) => {
    secretStore.setApiKey(String(value || ''));
    return { apiKeyConfigured: secretStore.hasApiKey() };
  };

  const runTurn = async (request, sendEvent) => {
    const requestId = String(request?.requestId || '');
    if (!requestId) throw new AiError('AI_INPUT_INVALID', 'requestId is required');
    if (activeTurns.has(requestId)) {
      throw new AiError('AI_TURN_ACTIVE', `AI turn ${requestId} is already running`);
    }

    const controller = new AbortController();
    const approvals = new Map();
    const event = (payload) => sendEvent({ requestId, ...payload });
    const requestApproval = (details) => new Promise((resolve, reject) => {
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

    const createRuntime = runtimeFactory || ((deps) => new AgentRuntime({
      tools: readCatalog().tools,
      model,
      executeTool,
      requestApproval: deps.requestApproval,
      externalToolProvider: deps.externalToolProvider,
    }));
    const runtime = createRuntime({ requestApproval, externalToolProvider });
    activeTurns.set(requestId, { controller, approvals });

    try {
      const ai = readSettings().ai || {};
      return await runtime.runTurn({
        ...request,
        config: {
          baseUrl: String(ai.baseUrl || ''),
          apiKey: secretStore.getApiKey(),
          model: String(ai.model || ''),
          maxSteps: Number(ai.maxSteps) || 6,
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
    runTurn,
    setApiKey,
  };
}

module.exports = { abortError, createAiService };
