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
  /** The cleanup itself, started at most once however it was asked for. */
  let putAway = null;
  /** Set by `holdQuit`, so the quit it asks for happens exactly once. */
  let quitting = null;
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
      console.warn('[magiespdf] quit cleanup timed out; carrying on anyway');
    } else {
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          console.warn('[magiespdf] quit cleanup step failed:', outcome.reason);
        }
      }
    }
    finished = true;
  };

  const start = () => {
    if (!putAway) putAway = run();
    return putAway;
  };

  return {
    /**
     * Answers `before-quit`: true means the quit was deferred and the caller
     * must preventDefault. False means the cleanup is done — let it through.
     */
    holdQuit() {
      if (finished) return false;
      if (!quitting) quitting = start().then(() => quit());
      return true;
    },

    /**
     * Put everything away *now*, without quitting.
     *
     * The macOS updater swaps the .app bundle this process is running from.
     * The worker pool and the editor host read files out of that bundle, so
     * they have to be shut down while it is still there — waiting for the
     * quit means they are torn down against a bundle that has been renamed
     * away, where they have nothing to talk to and simply burn the deadline.
     * A quit that follows is let straight through.
     */
    release() {
      return start();
    },

    /** Resolves once the cleanup has run (and, for a quit, that it was asked for). */
    settled() {
      return quitting ?? putAway ?? Promise.resolve();
    },
  };
}

module.exports = { createQuitCleanup, DEFAULT_TIMEOUT_MS };
