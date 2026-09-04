import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createEngineSaveTracker } from './engineSave.ts';

/** A clock whose timers only fire when the test says so. */
function testClock() {
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  return {
    clock: {
      setTimeout: (run: () => void, ms: number) => {
        const handle = next++;
        timers.set(handle, { at: now + ms, run });
        return handle;
      },
      clearTimeout: (handle: number) => {
        timers.delete(handle);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.run();
        }
      }
    },
    outstanding: () => timers.size,
  };
}

const TIMEOUT = 60_000;

describe('engine save tracker', () => {
  it('settles when the engine reports the document written', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const saving = tracker.begin('doc-1', TIMEOUT);
    assert.equal(tracker.pending(), true);

    tracker.saved();
    await saving;
    assert.equal(tracker.pending(), false);
  });

  /**
   * The point of the whole thing: "save and close" waits on this promise, so
   * resolving it before the bytes are on disk closes the tab over a save that
   * had not happened. See issue #22.
   */
  it('does not settle while the engine has not answered', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    let settled = false;
    void tracker.begin('doc-1', TIMEOUT).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false, 'still waiting on the engine');
  });

  it('rejects with the reason when the save fails', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const saving = tracker.begin('doc-1', TIMEOUT);
    tracker.failed('ENOSPC: no space left on device');

    await assert.rejects(() => saving, /no space left on device/);
    assert.equal(tracker.pending(), false);
  });

  it('rejects when the engine never answers', async () => {
    const { clock, advance } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const saving = tracker.begin('doc-1', TIMEOUT);
    advance(TIMEOUT);

    await assert.rejects(() => saving, /did not answer/i);
    assert.equal(tracker.pending(), false);
  });

  it('clears its timer once answered, so a late tick cannot reject a done save', async () => {
    const { clock, advance, outstanding } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const saving = tracker.begin('doc-1', TIMEOUT);
    tracker.saved();
    await saving;

    assert.equal(outstanding(), 0, 'the timeout was cleared');
    advance(TIMEOUT * 2);
  });

  it('fails the earlier request when a second one starts', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const first = tracker.begin('doc-1', TIMEOUT);
    const second = tracker.begin('doc-1', TIMEOUT);

    await assert.rejects(() => first, /superseded/i);

    tracker.saved();
    await second;
  });

  it('ignores an answer that belongs to no request', () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    assert.doesNotThrow(() => tracker.saved());
    assert.doesNotThrow(() => tracker.failed('whatever'));
    assert.equal(tracker.pending(), false);
  });

  it('reports which document is waiting, so a stale answer can be told apart', () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    assert.equal(tracker.waitingFor(), null);
    void tracker.begin('doc-7', TIMEOUT).catch(() => {});
    assert.equal(tracker.waitingFor(), 'doc-7');
  });
});
