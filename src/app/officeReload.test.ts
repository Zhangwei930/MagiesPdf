import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { setPathCaseSensitivity } from './documents.ts';
import { createReloadQueue } from './officeReload.ts';

/** Timers that only fire when the test says so. */
function testTimers() {
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  return {
    timers: {
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

const SETTLE = 900;

function queue(overrides: { settleMs?: number } = {}) {
  const { timers, advance, outstanding } = testTimers();
  const reloaded: string[] = [];
  const made = createReloadQueue({
    settleMs: overrides.settleMs ?? SETTLE,
    reload: (absolutePath) => {
      reloaded.push(absolutePath);
    },
    timers,
  });
  return { queue: made, reloaded, advance, outstanding };
}

describe('coalescing the reloads of AI-written documents', () => {
  it('reloads once when one file is written several times over', () => {
    const { queue: q, reloaded, advance } = queue();

    q.schedule('/docs/report.docx');
    q.schedule('/docs/report.docx');
    q.schedule('/docs/report.docx');
    advance(SETTLE);

    assert.deepEqual(reloaded, ['/docs/report.docx'], 'one reopen, not three engine boots');
  });

  /**
   * The bug in issue #30. One shared timer meant the second file's write
   * cancelled the first file's reload, and the tab that had already had its
   * session closed was left pointing at a session that no longer exists.
   */
  it('reloads both files when two different ones are written close together', () => {
    const { queue: q, reloaded, advance } = queue();

    q.schedule('/docs/a.docx');
    q.schedule('/docs/b.xlsx');
    advance(SETTLE);

    assert.deepEqual(reloaded.sort(), ['/docs/a.docx', '/docs/b.xlsx']);
  });

  it('keeps each file on its own settle window', () => {
    const { queue: q, reloaded, advance } = queue();

    q.schedule('/docs/a.docx');
    advance(SETTLE / 2);
    q.schedule('/docs/b.xlsx');
    advance(SETTLE / 2);

    assert.deepEqual(reloaded, ['/docs/a.docx'], 'a settled; b is still waiting');
    advance(SETTLE / 2);
    assert.deepEqual(reloaded, ['/docs/a.docx', '/docs/b.xlsx']);
  });

  it('reloads again when the same file is written after it settled', () => {
    const { queue: q, reloaded, advance } = queue();

    q.schedule('/docs/report.docx');
    advance(SETTLE);
    q.schedule('/docs/report.docx');
    advance(SETTLE);

    assert.deepEqual(reloaded, ['/docs/report.docx', '/docs/report.docx']);
  });

  it('counts two spellings of one path as one file', () => {
    // Windows spellings, and Windows is the only platform where a backslash
    // is a separator rather than a legal character in the name.
    setPathCaseSensitivity('win32');
    const { queue: q, reloaded, advance } = queue();

    q.schedule('C:\\Docs\\Report.docx');
    q.schedule('c:/docs/report.docx');
    advance(SETTLE);

    assert.equal(reloaded.length, 1, 'the same file, however it was spelled');
  });

  it('reloads the path as it arrived, not the key it was filed under', () => {
    const { queue: q, reloaded, advance } = queue();

    q.schedule('C:\\Docs\\Report.docx');
    advance(SETTLE);

    assert.deepEqual(reloaded, ['C:\\Docs\\Report.docx'], 'the filesystem needs the real path');
  });

  it('forgets a file once it has been reloaded', () => {
    const { queue: q, advance, outstanding } = queue();

    q.schedule('/docs/a.docx');
    advance(SETTLE);

    assert.equal(outstanding(), 0, 'no timer left behind');
    assert.deepEqual(q.waiting(), []);
  });

  /**
   * A session is closed just before the AI writes the file. Anything still
   * waiting for that file is about to be wrong — reopening mid-write boots the
   * engine on bytes that are already being replaced. Only that file, though:
   * cancelling everything is the bug this queue exists to fix.
   */
  it('cancels one file without touching what the others are waiting for', () => {
    const { queue: q, reloaded, advance } = queue();

    q.schedule('/docs/a.docx');
    q.schedule('/docs/b.xlsx');
    q.cancel('/docs/a.docx');
    advance(SETTLE);

    assert.deepEqual(reloaded, ['/docs/b.xlsx']);
  });

  it('shrugs at cancelling a file that was never waiting', () => {
    const { queue: q, reloaded, advance } = queue();

    q.cancel('/docs/never.docx');
    q.cancel('');
    q.schedule('/docs/a.docx');
    advance(SETTLE);

    assert.deepEqual(reloaded, ['/docs/a.docx']);
  });

  it('drops every pending reload when the subscription goes away', () => {
    const { queue: q, reloaded, advance, outstanding } = queue();

    q.schedule('/docs/a.docx');
    q.schedule('/docs/b.xlsx');
    q.cancelAll();
    advance(SETTLE * 2);

    assert.deepEqual(reloaded, []);
    assert.equal(outstanding(), 0);
  });

  it('ignores a write with no path', () => {
    const { queue: q, reloaded, advance } = queue();

    q.schedule('');
    advance(SETTLE);

    assert.deepEqual(reloaded, []);
  });
});
