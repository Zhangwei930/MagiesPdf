const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createJobExecutor } = require('./executor.cjs');

describe('shared job executor', () => {
  it('dispatches worker and main tools through their existing runners', async () => {
    const calls = [];
    const executor = createJobExecutor({
      tools: [
        { id: 'edit.compress', runtime: 'worker' },
        { id: 'convert.html-to-pdf', runtime: 'main' },
      ],
      pool: {
        run: async (request, onProgress) => {
          calls.push(['worker', request.toolId]);
          onProgress(0.5, { en: 'Half', zh: '一半' });
          return { files: [] };
        },
        cancel: () => false,
      },
      mainRunner: {
        run: async (request, host) => {
          calls.push(['main', request.toolId, host.kind]);
          return { files: [] };
        },
        cancel: () => false,
      },
      hostBridge: { kind: 'host' },
    });
    const progress = [];

    await executor.run({ jobId: 'one', toolId: 'edit.compress', files: [], params: {} }, (fraction) => progress.push(fraction));
    await executor.run({ jobId: 'two', toolId: 'convert.html-to-pdf', files: [], params: {} });

    assert.deepEqual(calls, [
      ['worker', 'edit.compress'],
      ['main', 'convert.html-to-pdf', 'host'],
    ]);
    assert.deepEqual(progress, [0.5]);
  });

  it('cancels the underlying job when an Agent turn aborts', async () => {
    let cancelled = '';
    let finish;
    const executor = createJobExecutor({
      tools: [{ id: 'edit.compress', runtime: 'worker' }],
      pool: {
        run: () => new Promise((resolve) => { finish = resolve; }),
        cancel: (jobId) => { cancelled = jobId; return true; },
      },
      mainRunner: { run: async () => ({ files: [] }), cancel: () => false },
      hostBridge: {},
    });
    const controller = new AbortController();
    const running = executor.run(
      { jobId: 'agent-job', toolId: 'edit.compress', files: [], params: {} },
      () => {},
      controller.signal,
    );

    controller.abort();
    assert.equal(cancelled, 'agent-job');
    finish({ files: [] });
    await running;
  });

  it('fails fast for an unknown tool id', async () => {
    const executor = createJobExecutor({
      tools: [],
      pool: { run: async () => ({ files: [] }), cancel: () => false },
      mainRunner: { run: async () => ({ files: [] }), cancel: () => false },
      hostBridge: {},
    });
    await assert.rejects(
      executor.run({ jobId: 'bad', toolId: 'missing', files: [], params: {} }),
      /Unknown tool/i,
    );
  });
});
