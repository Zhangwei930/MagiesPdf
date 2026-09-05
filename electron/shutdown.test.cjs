const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createShutdownSequence } = require('./shutdown.cjs');

function sequence(overrides = {}) {
  const done = [];
  const made = createShutdownSequence({
    mayClose: overrides.mayClose ?? (async () => true),
    holdQuit: overrides.holdQuit ?? (() => {
      done.push('cleanup');
      return true;
    }),
    quit: () => done.push('quit'),
    log: { warn: () => {} },
  });
  return { sequence: made, done };
}

/**
 * The cleanup destroys the worker pool, closes every editor session and stops
 * the API server. It used to run straight from `before-quit`, which is
 * *before* the unsaved prompt is answered — so cancelling the quit left an
 * application that could no longer open a document, run a tool, or save what
 * it was still holding, and nothing said so.
 */
describe('the order a quit happens in', () => {
  it('asks before anything is put away', async () => {
    const asked = [];
    const { sequence: s, done } = sequence({
      mayClose: async () => {
        asked.push('asked');
        return false;
      },
    });

    assert.equal(s.requestQuit(), true, 'the quit is deferred while asking');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(asked, ['asked']);
    assert.deepEqual(done, [], 'a cancelled quit must tear nothing down');
    assert.equal(s.isApproved(), false);
  });

  it('puts everything away once the quit is approved', async () => {
    const { sequence: s, done } = sequence();

    s.requestQuit();
    await new Promise((resolve) => setImmediate(resolve));

    // Approved, then asked to quit again — which is the pass that cleans up.
    assert.deepEqual(done, ['quit']);
    assert.equal(s.isApproved(), true);
    assert.equal(s.requestQuit(), true, 'held once more while the cleanup runs');
    assert.deepEqual(done, ['quit', 'cleanup']);
  });

  it('does not ask a second time once approved', async () => {
    let asks = 0;
    const { sequence: s } = sequence({
      mayClose: async () => {
        asks += 1;
        return true;
      },
    });

    s.requestQuit();
    await new Promise((resolve) => setImmediate(resolve));
    s.requestQuit();
    s.requestQuit();

    assert.equal(asks, 1);
  });

  it('lets the quit through once the cleanup says it is done', async () => {
    const { sequence: s } = sequence({ holdQuit: () => false });

    s.requestQuit();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(s.requestQuit(), false, 'nothing left to wait for');
  });

  /** A window that was closed and reopened is holding different documents. */
  it('asks again after a reset', async () => {
    let asks = 0;
    const { sequence: s } = sequence({
      mayClose: async () => {
        asks += 1;
        return true;
      },
    });

    s.requestQuit();
    await new Promise((resolve) => setImmediate(resolve));
    s.reset();
    assert.equal(s.isApproved(), false);

    s.requestQuit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asks, 2);
  });

  /** Deciding failed: the app stays, which is the safe direction. */
  it('keeps the app when it cannot tell whether it may go', async () => {
    const { sequence: s, done } = sequence({
      mayClose: async () => {
        throw new Error('the prompt failed');
      },
    });

    assert.equal(s.requestQuit(), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(done, []);
    assert.equal(s.isApproved(), false);
  });
});
