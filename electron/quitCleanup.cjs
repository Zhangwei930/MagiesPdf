/**
 * What has to be put away before the app may quit.
 *
 * The Office engine keeps a copy of every open document in a work directory
 * and serves it from a loopback server. Both are removed when a document is
 * closed — but quitting closes nothing, so a session open at the end used to
 * outlive the app: the directory stayed in temp with nothing left able to
 * remove it (issue #29).
 *
 * `before-quit` cannot be answered asynchronously, so the quit is refused once,
 * the work is done, and the quit is asked for again. Two things make that safe:
 * the second attempt is let through, and a step that never finishes cannot
 * strand the user in a window that will not close — after the deadline the app
 * quits anyway. Leaving a temp directory behind is a bad outcome; an app that
 * cannot be closed is a worse one.
 */

const DEFAULT_TIMEOUT_MS = 5000;

const REAL_CLOCK = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * @param {object} options
 * @param {Array<() => Promise<unknown>>} options.steps run together, best-effort
 * @param {() => void} options.quit asked for again once the steps are done
 */
function createQuitCleanup({ steps, quit, timeoutMs = DEFAULT_TIMEOUT_MS, clock = REAL_CLOCK }) {
  let running = null;
  let finished = false;

  const run = async () => {
    let deadline;
    const expired = new Promise((resolve) => {
      deadline = clock.setTimeout(resolve, timeoutMs);
    });
    const outcomes = await Promise.race([
      Promise.allSettled(steps.map((step) => step())),
      expired.then(() => null),
    ]);
    clock.clearTimeout(deadline);
    if (outcomes === null) {
      console.warn('[magiespdf] quit cleanup timed out; quitting anyway');
    } else {
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          console.warn('[magiespdf] quit cleanup step failed:', outcome.reason);
        }
      }
    }
    finished = true;
    quit();
  };

  return {
    /**
     * Answers `before-quit`: true means the quit was deferred and the caller
     * must preventDefault. False means the cleanup is done — let it through.
     */
    holdQuit() {
      if (finished) return false;
      if (!running) running = run();
      return true;
    },

    /** Resolves once the cleanup has run and the quit has been asked for again. */
    settled() {
      return running ?? Promise.resolve();
    },
  };
}

module.exports = { createQuitCleanup, DEFAULT_TIMEOUT_MS };
