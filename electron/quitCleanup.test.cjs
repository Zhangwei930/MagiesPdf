const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createQuitCleanup } = require('./quitCleanup.cjs');

function cleanup(overrides = {}) {
  const done = [];
  const timers = [];
  const made = createQuitCleanup({
    steps: overrides.steps ?? [
      async () => done.push('api'),
      async () => done.push('office'),
      async () => done.push('pool'),
    ],
    quit: () => done.push('quit'),
    timeoutMs: 1000,
    clock: {
      setTimeout: (run) => {
        timers.push(run);
        return timers.length;
      },
      clearTimeout: () => {},
    },
  });
  return { cleanup: made, done, fireTimeout: () => timers.forEach((run) => run()) };
}

describe('quitting once everything is put away', () => {
  it('holds the quit until every step has finished, then quits', async () => {
    const { cleanup: c, done } = cleanup();

    assert.equal(c.holdQuit(), true, 'the first attempt is deferred');
    await c.settled();

    assert.deepEqual(done, ['api', 'office', 'pool', 'quit']);
  });

  /**
   * `before-quit` fires again for the quit the cleanup itself asks for. Holding
   * that one too would mean the app never quits.
   */
  it('lets the quit through once the cleanup is done', async () => {
    const { cleanup: c } = cleanup();

    c.holdQuit();
    await c.settled();

    assert.equal(c.holdQuit(), false, 'nothing left to wait for');
  });

  it('runs the cleanup once however many times quitting is attempted', async () => {
    let runs = 0;
    const { cleanup: c } = cleanup({ steps: [async () => { runs += 1; }] });

    c.holdQuit();
    c.holdQuit();
    c.holdQuit();
    await c.settled();

    assert.equal(runs, 1);
  });

  /**
   * A step that throws must not strand the user in an app that will not close.
   * The work is best-effort; quitting is not.
   */
  it('quits even when a step fails', async () => {
    const { cleanup: c, done } = cleanup({
      steps: [
        async () => {
          throw new Error('the worker pool was already gone');
        },
        async () => done.push('office'),
      ],
    });

    c.holdQuit();
    await c.settled();

    assert.deepEqual(done, ['office', 'quit'], 'the other steps still ran');
  });

  it('runs every step rather than stopping at the first', async () => {
    const { cleanup: c, done } = cleanup();
    c.holdQuit();
    await c.settled();
    assert.equal(done.length, 4);
  });

  /**
   * A converter that will not exit, a request that never completes: the app
   * still has to close. Leaving a temp directory behind is worse than nothing,
   * but it is much better than a window the user cannot get rid of.
   */
  it('gives up and quits when a step never finishes', async () => {
    const { cleanup: c, done, fireTimeout } = cleanup({
      steps: [() => new Promise(() => {})],
    });

    c.holdQuit();
    fireTimeout();
    await c.settled();

    assert.deepEqual(done, ['quit']);
    assert.equal(c.holdQuit(), false);
  });

  it('does not quit twice when the straggler finishes after the deadline', async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { cleanup: c, done, fireTimeout } = cleanup({ steps: [() => held] });

    c.holdQuit();
    fireTimeout();
    await c.settled();
    release();
    await held;
    await Promise.resolve();

    assert.deepEqual(done.filter((entry) => entry === 'quit'), ['quit']);
  });
});
