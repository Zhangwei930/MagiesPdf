'use strict';

/**
 * In-app approval for Office tool calls that arrive over the local REST API
 * (which is also how the magies-office MCP server reaches this app).
 *
 * The built-in AI panel already asks before every Office tool call. A CLI agent
 * holding the API token used to skip that entirely, so "confirm" only really
 * bound the panel. This gate puts the same question in front of the user for
 * calls that come from outside, and answers deny whenever it cannot ask.
 *
 * Prompts are asked one at a time: an agent that fires five writes at once
 * would otherwise stack five dialogs, and a session grant given to the first
 * would arrive too late to settle the rest.
 *
 * A question nobody answers is a no. The caller is a waiting HTTP request, so
 * an unattended machine has to end up denied rather than holding the socket —
 * a late click on the abandoned dialog changes nothing.
 */

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * @param {{
 *   prompt: ((request: { functionName: string, toolId?: string, path?: string })
 *     => Promise<'once' | 'session' | 'deny'>) | null,
 *   timeoutMs?: number,
 * }} deps
 */
function createApprovalGate({ prompt, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /**
   * The user let the run proceed unattended. It covers every Office tool, not
   * just the one that happened to be asked about: a single request builds a
   * deck out of a dozen different tools, and a per-tool grant would ask again
   * for each of them — which is not what the button offered.
   */
  let grantedForRun = false;
  /** Serialises prompts; resolved value is irrelevant. */
  let queue = Promise.resolve();

  const ask = async (request) => {
    if (typeof prompt !== 'function') return false;
    let timer = null;
    try {
      const answer = await Promise.race([
        prompt(request),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('deny'), timeoutMs);
        }),
      ]);
      if (answer === 'session') {
        grantedForRun = true;
        return true;
      }
      return answer === 'once';
    } catch {
      // No window, a closed dialog, anything at all: the answer is no.
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    /** @returns {Promise<boolean>} whether this call may run. */
    request(request) {
      const pending = queue.then(async () => {
        if (grantedForRun) return true;
        return ask(request);
      });
      // Keep the chain alive whatever this answer was.
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    },

    /** Drop the run-wide grant — the API restarted, or the mode changed. */
    reset() {
      grantedForRun = false;
    },
  };
}

module.exports = { createApprovalGate, DEFAULT_TIMEOUT_MS };
