'use strict';

/**
 * Whether the window may close.
 *
 * Closing a tab asked about unsaved changes; closing the window did not. The
 * close button, ⌘Q and Alt+F4 all went straight through, taking every unsaved
 * document with them — which is the one moment a document editor must not get
 * wrong.
 *
 * The decision lives here, apart from the window, because the interesting part
 * is not the dialog: it is that a *failed* save must keep the window open. A
 * prompt that offers to save and then quits regardless destroys exactly what
 * the user asked it to protect.
 */
function createCloseGuard({ unsavedDocuments, ask, saveAll }) {
  // Closing again while the dialog is up must not stack a second one. The
  // pending answer is shared, and only the attempt that owns it may close.
  let asking = null;

  return {
    async mayClose() {
      const unsaved = unsavedDocuments();
      if (unsaved.length === 0) return true;

      if (asking) {
        await asking;
        return false;
      }

      const answer = (async () => {
        const choice = await ask(unsaved);
        if (choice === 'cancel') return false;
        if (choice === 'discard') return true;
        try {
          const result = await saveAll();
          return result?.saved === true;
        } catch {
          // Nothing reached disk, so there is nothing safe about closing.
          return false;
        }
      })();

      asking = answer;
      try {
        return await answer;
      } finally {
        asking = null;
      }
    },
  };
}

/**
 * The prompt itself.
 *
 * An OS dialog is right here and wrong elsewhere: this one has to block the
 * window from closing, which an in-app panel cannot do. (The AI approval
 * prompt is the opposite case and is drawn in the panel — `main.cjs` asserts
 * it never reaches for a message box.) `dialog` is injected so this stays
 * testable outside Electron.
 */
function createQuitPrompt({ dialog, getWindow, listLimit = 5 }) {
  return async function ask(names) {
    const listed = names.slice(0, listLimit).join('\n');
    const more = names.length > listLimit ? `\n… ${names.length - listLimit}` : '';
    const { response } = await dialog.showMessageBox(getWindow() ?? undefined, {
      type: 'warning',
      buttons: ['全部保存', '不保存并退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      title: '退出前保存修改吗？',
      message: '以下文档有未保存的修改：',
      detail: `${listed}${more}`,
      noLink: true,
    });
    if (response === 0) return 'save';
    if (response === 1) return 'discard';
    return 'cancel';
  };
}

/**
 * Asks the renderer to write everything and waits for its answer.
 *
 * Each request carries a ticket, so a late reply to an abandoned attempt
 * cannot settle the current one. A renderer that never answers must not hold
 * the window hostage either, hence the deadline.
 */
function createSaveAllRequester({ getContents, send, timeoutMs = 60_000, clock = { setTimeout, clearTimeout } }) {
  let ticket = 0;
  const waiting = new Map();

  return {
    saveAll() {
      const contents = getContents();
      if (!contents) return Promise.resolve({ saved: false });

      const id = ++ticket;
      return new Promise((resolve) => {
        const timer = clock.setTimeout(() => {
          if (waiting.delete(id)) resolve({ saved: false });
        }, timeoutMs);
        waiting.set(id, { resolve, timer });
        send(contents, { id });
      });
    },

    /** Called with whatever the renderer reported. */
    settle(payload) {
      const held = waiting.get(payload?.id);
      if (!held) return;
      waiting.delete(payload.id);
      clock.clearTimeout(held.timer);
      held.resolve({ saved: payload?.saved === true, message: payload?.message });
    },
  };
}

module.exports = { createCloseGuard, createQuitPrompt, createSaveAllRequester };
