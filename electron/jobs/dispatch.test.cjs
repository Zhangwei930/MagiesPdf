const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { poolDispatcher } = require('./dispatch.cjs');

function fakePool() {
  const calls = [];
  const cancelled = [];
  let settle;
  return {
    calls,
    cancelled,
    finish: (value) => settle.resolve(value),
    fail: (cause) => settle.reject(cause),
    pool: {
      run(request, onProgress) {
        calls.push({ request, onProgress });
        return new Promise((resolve, reject) => {
          settle = { resolve, reject };
        });
      },
      cancel(jobId) {
        cancelled.push(jobId);
      },
    },
  };
}

/**
 * `advanced.batch` and `advanced.pipeline` run in the main process, because a
 * step might need the host. This is how the steps that do not get back out to
 * the worker pool — without it, the main process does their work and nothing
 * else in the app moves until the run finishes.
 *
 * Both entry points need it. The desktop one had it and the local REST API
 * did not, so a batch started over the API still froze everything.
 */
describe('handing a step back to the job pool', () => {
  it('runs the tool it was given', async () => {
    const { pool, calls, finish } = fakePool();
    const dispatch = poolDispatcher(pool, () => 'job-1');

    const running = dispatch('edit.compress', [{ name: 'a.pdf' }], { level: 'high' });
    finish({ files: [] });
    await running;

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request, {
      jobId: 'job-1',
      toolId: 'edit.compress',
      files: [{ name: 'a.pdf' }],
      params: { level: 'high' },
    });
  });

  it('gives every step its own job id', async () => {
    let n = 0;
    const { pool, calls, finish } = fakePool();
    const dispatch = poolDispatcher(pool, () => `job-${(n += 1)}`);

    const first = dispatch('a', [], {});
    finish({ files: [] });
    await first;
    const second = dispatch('b', [], {});
    finish({ files: [] });
    await second;

    assert.deepEqual(calls.map((call) => call.request.jobId), ['job-1', 'job-2']);
  });

  it('passes progress through', async () => {
    const { pool, calls, finish } = fakePool();
    const seen = [];
    const running = poolDispatcher(pool, () => 'job-1')(
      'edit.compress', [], {}, undefined,
      (fraction, message) => seen.push([fraction, message]),
    );

    calls[0].onProgress(0.5, { zh: '', en: 'half' });
    finish({ files: [] });
    await running;

    assert.deepEqual(seen, [[0.5, { zh: '', en: 'half' }]]);
  });

  /** Cancelling a batch has to reach the step that is actually running. */
  it('cancels the step when the run is cancelled', async () => {
    const { pool, cancelled, finish } = fakePool();
    const controller = new AbortController();
    const running = poolDispatcher(pool, () => 'job-1')(
      'edit.compress', [], {}, controller.signal,
    );

    controller.abort();
    assert.deepEqual(cancelled, ['job-1']);

    finish({ files: [] });
    await running;
  });

  it('stops listening for the abort once the step is done', async () => {
    const { pool, cancelled, finish } = fakePool();
    const controller = new AbortController();
    const running = poolDispatcher(pool, () => 'job-1')(
      'edit.compress', [], {}, controller.signal,
    );

    finish({ files: [] });
    await running;
    controller.abort();

    assert.deepEqual(cancelled, [], 'a finished step must not be cancelled later');
  });

  it('lets a failure through', async () => {
    const { pool, fail } = fakePool();
    const running = poolDispatcher(pool, () => 'job-1')('edit.compress', [], {});
    fail(new Error('tool failed'));
    await assert.rejects(running, /tool failed/);
  });
});
