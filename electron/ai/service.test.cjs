const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createAiService } = require('./service.cjs');

function serviceWith(overrides = {}) {
  const settings = {
    ai: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      maxSteps: 6,
    },
  };
  let apiKey = 'encrypted-key';
  return createAiService({
    readCatalog: () => ({ tools: [] }),
    readSettings: () => settings,
    secretStore: {
      hasApiKey: () => apiKey !== '',
      getApiKey: () => apiKey,
      setApiKey: (value) => { apiKey = value; },
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
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      maxSteps: 6,
      apiKeyConfigured: true,
    });
    assert.equal(JSON.stringify(service.getConfig()).includes('encrypted-key'), false);
  });

  it('stores and clears the API key through the secret adapter', () => {
    const service = serviceWith();
    assert.deepEqual(service.setApiKey('next-key'), { apiKeyConfigured: true });
    assert.deepEqual(service.setApiKey(''), { apiKeyConfigured: false });
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
});
