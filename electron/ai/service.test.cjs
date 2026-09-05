const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createAiService } = require('./service.cjs');

function serviceWith({ permissionMode, ...overrides } = {}) {
  const settings = {
    ai: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      maxSteps: 6,
      ...(permissionMode ? { permissionMode } : {}),
    },
  };
  // Keyed by secret name: the migrated provider reads the pre-list `apiKey`.
  const secrets = { apiKey: 'encrypted-key' };
  return createAiService({
    readCatalog: () => ({ tools: [] }),
    readSettings: () => settings,
    secretStore: {
      hasSecret: (key) => typeof secrets[key] === 'string' && secrets[key] !== '',
      getSecret: (key) => secrets[key] || '',
      setSecret: (key, value) => {
        if (value) secrets[key] = value;
        else delete secrets[key];
      },
    },
    executeTool: async () => ({ files: [] }),
    model: {},
    runtimeFactory: () => ({ runTurn: async () => ({ message: 'ok', files: [] }) }),
    ...overrides,
  });
}

describe('AI service', () => {
  it('reports model configuration without exposing the API key', () => {
    const service = serviceWith();
    assert.deepEqual(service.getConfig(), {
      providers: [{
        id: 'legacy',
        providerId: 'custom',
        name: 'Custom',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'local-model',
        reasoningEffort: '',
        enabled: true,
        apiKeyConfigured: true,
      }],
      activeProviderId: 'legacy',
      maxSteps: 6,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      apiKeyConfigured: true,
    });
    assert.equal(JSON.stringify(service.getConfig()).includes('encrypted-key'), false);
  });

  it('stores and clears the API key of a provider through the secret adapter', () => {
    const service = serviceWith();
    assert.deepEqual(service.setApiKey('next-key'), { providerId: 'legacy', apiKeyConfigured: true });
    assert.deepEqual(service.setApiKey(''), { providerId: 'legacy', apiKeyConfigured: false });
  });

  it('refuses a remote turn while strict local privacy is on', async () => {
    const service = serviceWith({
      readSettings: () => ({
        ai: {
          strictLocalPrivacy: true,
          providers: [{ id: 'a', name: 'A', baseUrl: 'https://api.example.com/v1', model: 'm', enabled: true }],
          activeProviderId: 'a',
        },
      }),
    });
    await assert.rejects(
      () => service.runTurn({ requestId: 'strict-1', prompt: 'hi' }, () => {}),
      (error) => error.code === 'AI_STRICT_LOCAL_PRIVACY',
    );
  });

  it('still runs a loopback turn while strict local privacy is on', async () => {
    const service = serviceWith({
      readSettings: () => ({
        ai: {
          strictLocalPrivacy: true,
          providers: [{ id: 'a', name: 'A', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', enabled: true }],
          activeProviderId: 'a',
        },
      }),
    });
    const result = await service.runTurn({ requestId: 'strict-2', prompt: 'hi' }, () => {});
    assert.equal(result.message, 'ok');
  });

  it('refuses a turn when no provider is configured', async () => {
    const service = serviceWith({ readSettings: () => ({ ai: { providers: [], activeProviderId: '' } }) });
    await assert.rejects(
      () => service.runTurn({ requestId: 'turn-none', prompt: 'hi' }, () => {}),
      (error) => error.code === 'AI_CONFIG_INVALID',
    );
  });

  it('correlates approval events and resumes the pending turn', async () => {
    const events = [];
    const service = serviceWith({
      runtimeFactory: ({ requestApproval }) => ({
        async runTurn() {
          const approved = await requestApproval({ toolId: 'edit.compress', toolName: { zh: '压缩', en: 'Compress' } });
          return { message: approved ? 'approved' : 'denied', files: [] };
        },
      }),
    });

    const running = service.runTurn({ requestId: 'turn-1', prompt: '压缩' }, (event) => events.push(event));
    await new Promise((resolve) => setImmediate(resolve));

    const approval = events.find((event) => event.type === 'approval_required');
    assert.equal(approval.requestId, 'turn-1');
    assert.equal(approval.toolId, 'edit.compress');
    assert.equal(service.respondApproval('turn-1', approval.approvalId, true), true);
    assert.deepEqual(await running, { message: 'approved', files: [] });
    assert.ok(events.some((event) =>
      event.type === 'approval_cleared' && event.approvalId === approval.approvalId));
    assert.equal(service.respondApproval('turn-1', approval.approvalId, true), false);
  });

  it('aborts a running turn and clears pending approvals', async () => {
    const events = [];
    const service = serviceWith({
      runtimeFactory: ({ requestApproval }) => ({
        async runTurn() {
          await requestApproval({ toolId: 'edit.compress', toolName: { zh: '压缩', en: 'Compress' } });
          return { message: 'unexpected', files: [] };
        },
      }),
    });

    const running = service.runTurn({ requestId: 'turn-2', prompt: '压缩' }, (event) => events.push(event));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.cancelTurn('turn-2'), true);
    await assert.rejects(running, (error) => error.name === 'AbortError');
    assert.ok(events.some((event) => event.type === 'approval_cleared'));
    assert.equal(service.cancelTurn('turn-2'), false);
  });

  it('rejects duplicate request ids', async () => {
    let finish;
    const service = serviceWith({
      runtimeFactory: () => ({
        runTurn: () => new Promise((resolve) => { finish = resolve; }),
      }),
    });
    const first = service.runTurn({ requestId: 'same', prompt: 'one' }, () => {});
    await assert.rejects(
      service.runTurn({ requestId: 'same', prompt: 'two' }, () => {}),
      (error) => error.code === 'AI_TURN_ACTIVE',
    );
    finish({ message: 'done', files: [] });
    await first;
  });

  it('passes the external MCP provider into the Agent runtime factory', async () => {
    const externalToolProvider = { listTools: async () => [] };
    let runtimeDependencies;
    const service = serviceWith({
      externalToolProvider,
      runtimeFactory: (dependencies) => {
        runtimeDependencies = dependencies;
        return { runTurn: async () => ({ message: 'ok', files: [] }) };
      },
    });

    await service.runTurn({ requestId: 'external-provider', prompt: 'search' }, () => {});
    assert.equal(runtimeDependencies.externalToolProvider, externalToolProvider);
  });

  it('passes the local Office provider into the Agent runtime factory', async () => {
    const officeToolProvider = { listTools: async () => [] };
    let runtimeDependencies;
    const service = serviceWith({
      officeToolProvider,
      runtimeFactory: (dependencies) => {
        runtimeDependencies = dependencies;
        return { runTurn: async () => ({ message: 'ok', files: [] }) };
      },
    });

    await service.runTurn({ requestId: 'office-provider', prompt: 'read Word' }, () => {});
    assert.equal(runtimeDependencies.officeToolProvider, officeToolProvider);
  });

  it('runs unattended turns with only explicitly allowed local Office tools', async () => {
    const listed = [
      { functionName: 'read', toolId: 'office:excel:read' },
      { functionName: 'write', toolId: 'office:excel:write' },
    ];
    const officeToolProvider = {
      listTools: async () => listed,
      callTool: async () => ({}),
    };
    let dependencies;
    const service = serviceWith({
      officeToolProvider,
      externalToolProvider: { listTools: async () => [{ toolId: 'external:danger' }] },
      runtimeFactory: (received) => {
        dependencies = received;
        return {
          async runTurn({ onEvent }) {
            assert.deepEqual(await received.officeToolProvider.listTools(), [listed[0]]);
            assert.equal(await received.requestApproval({ toolId: 'office:excel:read' }), true);
            onEvent({ type: 'tool_result', toolId: 'office:excel:read', ok: true });
            return { message: 'done', files: [] };
          },
        };
      },
    });

    const result = await service.runUnattended({
      requestId: 'automation-1',
      prompt: 'read workbook',
      allowedToolIds: ['office:excel:read'],
    }, () => {});

    assert.deepEqual(result, { message: 'done', files: [] });
    assert.equal(dependencies.externalToolProvider, undefined);
  });

  /**
   * An unattended rule runs against a folder with nobody watching, and its
   * allow-list is the whole of what makes that safe. Two things went around it.
   *
   * Web search was never turned off: the override list dropped the external
   * MCP provider but the web provider was resolved with `||`, which cannot be
   * switched off by passing undefined. So a rule allowing one Office tool got
   * a runtime that could also reach the network.
   *
   * And the allow-list is only consulted by `requestApproval`, which auto mode
   * skips entirely — so even a tool that never appeared in the list would have
   * run, had it been registered.
   */
  it('gives an unattended turn no way to reach the network', async () => {
    let dependencies;
    const service = serviceWith({
      officeToolProvider: {
        listTools: async () => [{ functionName: 'read', toolId: 'office:excel:read' }],
        callTool: async () => ({}),
      },
      webSearchProvider: { search: async () => [{ title: 'a result' }] },
      runtimeFactory: (received) => {
        dependencies = received;
        return {
          async runTurn({ onEvent }) {
            onEvent({ type: 'tool_result', toolId: 'office:excel:read', ok: true });
            return { message: 'done', files: [] };
          },
        };
      },
    });

    await service.runUnattended({
      requestId: 'automation-web',
      prompt: 'read workbook',
      allowedToolIds: ['office:excel:read'],
    }, () => {});

    assert.equal(dependencies.webSearchProvider, undefined, 'web search must not be registered');
  });

  it('never runs an unattended turn in a mode that skips the allow-list', async () => {
    let seen;
    const service = serviceWith({
      permissionMode: 'auto',
      officeToolProvider: {
        listTools: async () => [{ functionName: 'read', toolId: 'office:excel:read' }],
        callTool: async () => ({}),
      },
      runtimeFactory: () => ({
        async runTurn({ config, onEvent }) {
          seen = config.permissionMode;
          onEvent({ type: 'tool_result', toolId: 'office:excel:read', ok: true });
          return { message: 'done', files: [] };
        },
      }),
    });

    await service.runUnattended({
      requestId: 'automation-mode',
      prompt: 'read workbook',
      allowedToolIds: ['office:excel:read'],
    }, () => {});

    assert.notEqual(seen, 'auto', 'auto approves without asking, and asking is the allow-list');
  });

  it('rejects unsafe unattended allowlists and turns without a successful tool', async () => {
    const service = serviceWith({
      officeToolProvider: { listTools: async () => [] },
      runtimeFactory: () => ({ runTurn: async () => ({ message: 'no tool', files: [] }) }),
    });
    await assert.rejects(() => service.runUnattended({
      requestId: 'bad', prompt: 'task', allowedToolIds: ['external:danger'],
    }, () => {}), /office:/);
    await assert.rejects(() => service.runUnattended({
      requestId: 'bad-macro', prompt: 'task', allowedToolIds: ['office:macro:run'],
    }, () => {}), /interactive approval/);
    await assert.rejects(() => service.runUnattended({
      requestId: 'no-tool', prompt: 'task', allowedToolIds: ['office:excel:read'],
    }, () => {}), /successful Office tool/);
  });
});

/**
 * Web search could be configured in Settings and then quietly did nothing.
 * The service worked out the provider and handed it to the runtime factory —
 * but the *default* factory, the one every ordinary chat goes through, did not
 * forward it to `AgentRuntime`. The runtime accepted the option and never
 * received it, so no search tool was ever registered and the model was never
 * told the capability existed.
 *
 * Only the injected factory used by these tests passed it on, which is why
 * nothing caught it.
 */
describe('web search reaches the runtime it was configured for', () => {
  it('hands the provider to the runtime the default factory builds', async () => {
    let listed = 0;
    // The shape the runtime consumes: a function name plus the tool definition
    // it hands to the model.
    const provider = {
      listTools: async () => {
        listed += 1;
        return [{
          functionName: 'web_search',
          providerTool: {
            type: 'function',
            function: { name: 'web_search', description: 'search', parameters: { type: 'object' } },
          },
        }];
      },
      callTool: async () => ({ ok: true, content: '' }),
    };

    let toolNames = [];
    const service = serviceWith({
      // No runtimeFactory: this must go through the real default path.
      runtimeFactory: undefined,
      webSearchProvider: provider,
      readCatalog: () => ({ tools: [] }),
      model: {
        async streamMessage(request) {
          toolNames = (request.tools || []).map((entry) => entry?.function?.name).filter(Boolean);
          return { content: 'done', tool_calls: [] };
        },
      },
    });

    await service.runTurn({ requestId: 'web-1', prompt: 'what is the news' }, () => {});

    assert.equal(listed > 0, true, 'the provider was asked for its tools');
    assert.ok(toolNames.includes('web_search'), `the model was offered: ${toolNames.join(', ')}`);
  });
});
