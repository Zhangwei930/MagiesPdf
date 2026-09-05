'use strict';

/**
 * The order a quit happens in.
 *
 * Two things have to happen before the app goes, and they were happening in
 * the wrong order. `quitCleanup` destroys the worker pool, closes every editor
 * session and stops the API server; `closeGuard` asks about unsaved documents.
 * The cleanup ran straight from `before-quit`, which is *before* the prompt is
 * answered — so cancelling the quit left an application that could no longer
 * open a document, run a tool, or save what it was still holding, with nothing
 * on screen to say so.
 *
 * Asking comes first. Only a quit that has been approved tears anything down,
 * and the approval is remembered so the window's own close handler does not
 * ask a second time on the way out.
 */

/**
 * @param {object} options
 * @param {() => Promise<boolean>} options.mayClose the unsaved-documents prompt
 * @param {() => boolean} options.holdQuit runs the cleanup; true means "defer"
 * @param {() => void} options.quit asks for the quit again once approved
 */
function createShutdownSequence({ mayClose, holdQuit, quit, log = console }) {
  let approved = false;

  return {
    /**
     * Answers `before-quit`. True means the quit was deferred and the caller
     * must call `preventDefault`.
     */
    requestQuit() {
      if (approved) return holdQuit();

      void mayClose()
        .then((may) => {
          // Cancelled. Nothing has been put away, so the app is exactly as it
          // was — which is the whole point of asking first.
          if (!may) return;
          approved = true;
          quit();
        })
        .catch((cause) => {
          // Deciding failed; the app stays, which is the safe direction.
          log.warn?.('[magiespdf] could not decide whether to quit:', cause);
        });
      return true;
    },

    /** Whether a window may close without being asked about again. */
    isApproved() {
      return approved;
    },

    /**
     * The window's own close prompt was answered "go ahead". A quit that
     * follows must not ask the same question again.
     */
    approveClose() {
      approved = true;
    },

    /** A reopened window holds different documents; the old answer is spent. */
    reset() {
      approved = false;
    },
  };
}

module.exports = { createShutdownSequence };
