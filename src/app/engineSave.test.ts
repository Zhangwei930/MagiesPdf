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

    tracker.saved('doc-1');
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
    tracker.failed('doc-1', 'ENOSPC: no space left on device');

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
    tracker.saved('doc-1');
    await saving;

    assert.equal(outstanding(), 0, 'the timeout was cleared');
    advance(TIMEOUT * 2);
  });

  /**
   * This used to supersede: the second request replaced the first and rejected
   * it. That left two callers with different fates for one document, and the
   * engine — which answers per session — could not tell which one its answer
   * belonged to. They join instead.
   */
  it('joins a second request for the same document to the first', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const first = tracker.begin('doc-1', TIMEOUT);
    const second = tracker.begin('doc-1', TIMEOUT);
    assert.equal(first, second, 'one request, two waiters');

    tracker.saved('doc-1');
    await first;
    await second;
  });

  it('ignores an answer that belongs to no request', () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    assert.doesNotThrow(() => tracker.saved('doc-1'));
    assert.doesNotThrow(() => tracker.failed('doc-1', 'whatever'));
    assert.equal(tracker.pending(), false);
  });

  it('reports which document is waiting, so a stale answer can be told apart', () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    assert.deepEqual(tracker.waitingFor(), []);
    void tracker.begin('doc-7', TIMEOUT).catch(() => {});
    assert.deepEqual(tracker.waitingFor(), ['doc-7']);
  });
});

/**
 * The tracker held one outstanding request for the whole app. Two documents
 * saving at once — "save all" on quit is exactly that — meant the second
 * superseded the first, and whichever event arrived first settled whoever was
 * waiting. Save A, save B, and A's late answer resolved B: B's tab then closed
 * believing it was on disk.
 *
 * Requests are per document now, so an answer can only settle the document it
 * belongs to.
 */
describe('two documents saving at once', () => {
  it('keeps one request per document', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const a = tracker.begin('doc-a', TIMEOUT);
    const b = tracker.begin('doc-b', TIMEOUT);

    tracker.saved('doc-a');
    await a;
    assert.equal(tracker.pending(), true, 'b is still waiting');

    tracker.saved('doc-b');
    await b;
    assert.equal(tracker.pending(), false);
  });

  it('does not let one document answer for another', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    let settled = false;
    void tracker.begin('doc-b', TIMEOUT).then(() => {
      settled = true;
    }, () => {
      settled = true;
    });

    tracker.saved('doc-a');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false, "a's answer is not b's");
  });

  it('fails only the document whose save failed', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const a = tracker.begin('doc-a', TIMEOUT);
    const b = tracker.begin('doc-b', TIMEOUT);

    tracker.failed('doc-a', 'ENOSPC');
    await assert.rejects(() => a, /ENOSPC/);

    tracker.saved('doc-b');
    await b;
  });

  /**
   * Two saves of the same document is the case a document id alone cannot
   * tell apart, so they are not allowed to exist at once: the second joins the
   * first rather than replacing it.
   */
  it('joins a second save of the same document to the one in flight', async () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const first = tracker.begin('doc-a', TIMEOUT);
    const second = tracker.begin('doc-a', TIMEOUT);

    tracker.saved('doc-a');
    await first;
    await second;
  });

  it('times out only the document that ran out of time', async () => {
    const { clock, advance } = testClock();
    const tracker = createEngineSaveTracker(clock);

    const a = tracker.begin('doc-a', TIMEOUT);
    const b = tracker.begin('doc-b', TIMEOUT * 4);

    advance(TIMEOUT);
    await assert.rejects(() => a, /did not answer/i);

    tracker.saved('doc-b');
    await b;
  });

  it('reports which documents are waiting', () => {
    const { clock } = testClock();
    const tracker = createEngineSaveTracker(clock);

    void tracker.begin('doc-a', TIMEOUT).catch(() => {});
    void tracker.begin('doc-b', TIMEOUT).catch(() => {});
    assert.deepEqual(tracker.waitingFor().sort(), ['doc-a', 'doc-b']);
  });
});
