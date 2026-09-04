const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createCloseGuard,
  createQuitPrompt,
  createSaveAllRequester,
} = require('./closeGuard.cjs');

function guard(overrides = {}) {
  const asked = [];
  const calls = { saved: 0 };
  const made = createCloseGuard({
    unsavedDocuments: overrides.unsavedDocuments ?? (() => []),
    ask: overrides.ask ?? (async (names) => {
      asked.push(names);
      return 'cancel';
    }),
    saveAll: overrides.saveAll ?? (async () => {
      calls.saved += 1;
      return { saved: true };
    }),
  });
  return { guard: made, asked, calls };
}

describe('closing with unsaved work', () => {
  it('closes without asking when nothing is unsaved', async () => {
    const { guard: g, asked } = guard();
    assert.equal(await g.mayClose(), true);
    assert.deepEqual(asked, []);
  });

  it('asks about every unsaved document, not just the active one', async () => {
    const { guard: g, asked } = guard({
      unsavedDocuments: () => ['报告.docx', 'scan.pdf', 'book.xlsx'],
    });

    await g.mayClose();
    assert.deepEqual(asked, [['报告.docx', 'scan.pdf', 'book.xlsx']]);
  });

  it('refuses to close when the user cancels', async () => {
    const { guard: g } = guard({
      unsavedDocuments: () => ['报告.docx'],
      ask: async () => 'cancel',
    });
    assert.equal(await g.mayClose(), false);
  });

  it('closes without saving when the user discards', async () => {
    const { guard: g, calls } = guard({
      unsavedDocuments: () => ['报告.docx'],
      ask: async () => 'discard',
    });

    assert.equal(await g.mayClose(), true);
    assert.equal(calls.saved, 0, 'discarding must not write anything');
  });

  it('saves and then closes', async () => {
    const { guard: g, calls } = guard({
      unsavedDocuments: () => ['报告.docx'],
      ask: async () => 'save',
    });

    assert.equal(await g.mayClose(), true);
    assert.equal(calls.saved, 1);
  });

  /**
   * The whole point. A save that failed leaves the work only in memory, so
   * quitting anyway destroys exactly what the prompt promised to protect.
   */
  it('stays open when the save fails', async () => {
    const { guard: g } = guard({
      unsavedDocuments: () => ['报告.docx'],
      ask: async () => 'save',
      saveAll: async () => ({ saved: false, message: 'ENOSPC: no space left on device' }),
    });

    assert.equal(await g.mayClose(), false);
  });

  it('stays open when saving throws rather than reporting', async () => {
    const { guard: g } = guard({
      unsavedDocuments: () => ['报告.docx'],
      ask: async () => 'save',
      saveAll: async () => {
        throw new Error('the renderer is gone');
      },
    });

    assert.equal(await g.mayClose(), false);
  });

  it('does not ask twice while it is already asking', async () => {
    let asks = 0;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const { guard: g } = guard({
      unsavedDocuments: () => ['报告.docx'],
      ask: async () => {
        asks += 1;
        await held;
        return 'discard';
      },
    });

    const first = g.mayClose();
    const second = g.mayClose();
    release();

    assert.deepEqual(await Promise.all([first, second]), [true, false]);
    assert.equal(asks, 1, 'a second close attempt must not stack another dialog');
  });

  it('asks again after an answer, so a cancelled close can be retried', async () => {
    let asks = 0;
    const { guard: g } = guard({
      unsavedDocuments: () => ['报告.docx'],
      ask: async () => {
        asks += 1;
        return asks === 1 ? 'cancel' : 'discard';
      },
    });

    assert.equal(await g.mayClose(), false);
    assert.equal(await g.mayClose(), true);
    assert.equal(asks, 2);
  });
});

describe('the quit prompt', () => {
  function prompt(response, capture = {}) {
    const dialog = {
      showMessageBox: async (_window, options) => {
        Object.assign(capture, options);
        return { response };
      },
    };
    return createQuitPrompt({ dialog, getWindow: () => null, listLimit: 2 });
  }

  it('maps the three buttons to the three answers', async () => {
    assert.equal(await prompt(0)(['a.docx']), 'save');
    assert.equal(await prompt(1)(['a.docx']), 'discard');
    assert.equal(await prompt(2)(['a.docx']), 'cancel');
  });

  it('names the documents rather than only counting them', async () => {
    const shown = {};
    await prompt(2, shown)(['报告.docx', 'scan.pdf']);
    assert.match(shown.detail, /报告\.docx/);
    assert.match(shown.detail, /scan\.pdf/);
  });

  it('summarises the tail instead of growing without limit', async () => {
    const shown = {};
    await prompt(2, shown)(['a.docx', 'b.pdf', 'c.xlsx', 'd.pptx']);
    assert.match(shown.detail, /a\.docx/);
    assert.doesNotMatch(shown.detail, /d\.pptx/);
    assert.match(shown.detail, /… 2/);
  });

  it('makes cancel the escape key, so dismissing the dialog keeps the window', async () => {
    const shown = {};
    await prompt(2, shown)(['a.docx']);
    assert.equal(shown.cancelId, 2);
  });
});

describe('asking the renderer to save everything', () => {
  function requester(overrides = {}) {
    const sends = [];
    const timers = new Map();
    let next = 1;
    const made = createSaveAllRequester({
      getContents: overrides.getContents ?? (() => ({})),
      send: (_contents, payload) => sends.push(payload),
      timeoutMs: 1000,
      clock: {
        setTimeout: (run) => {
          const handle = next++;
          timers.set(handle, run);
          return handle;
        },
        clearTimeout: (handle) => timers.delete(handle),
      },
    });
    return { requester: made, sends, fireTimers: () => [...timers.values()].forEach((run) => run()) };
  }

  it('settles with what the renderer reported', async () => {
    const { requester: r, sends } = requester();
    const saving = r.saveAll();
    r.settle({ id: sends[0].id, saved: true });
    assert.deepEqual(await saving, { saved: true, message: undefined });
  });

  it('carries the failure message back', async () => {
    const { requester: r, sends } = requester();
    const saving = r.saveAll();
    r.settle({ id: sends[0].id, saved: false, message: 'ENOSPC' });
    assert.deepEqual(await saving, { saved: false, message: 'ENOSPC' });
  });

  it('gives up rather than holding the window when nothing answers', async () => {
    const { requester: r, fireTimers } = requester();
    const saving = r.saveAll();
    fireTimers();
    assert.deepEqual(await saving, { saved: false });
  });

  it('ignores a reply to an attempt that already timed out', async () => {
    const { requester: r, sends, fireTimers } = requester();
    const first = r.saveAll();
    fireTimers();
    assert.deepEqual(await first, { saved: false });

    assert.doesNotThrow(() => r.settle({ id: sends[0].id, saved: true }));
  });

  it('reports failure when there is no renderer left to ask', async () => {
    const { requester: r } = requester({ getContents: () => null });
    assert.deepEqual(await r.saveAll(), { saved: false });
  });
});
