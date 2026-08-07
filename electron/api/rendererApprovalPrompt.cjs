'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Asks the user, in the app's own window, about an Office tool call that
 * arrived over the local REST API / magies-office MCP.
 *
 * The question belongs where the work is being watched — the AI panel — rather
 * than in a modal OS dialog that steals focus from whatever the user is doing.
 * Same shape as Magies Terminal's external-MCP approvals: the card can appear
 * whether or not the panel has ever been opened.
 *
 * Anything other than an explicit yes is a no: no window, a closed window, an
 * answer that never comes, an answer this module does not recognise.
 */

const DEFAULT_TIMEOUT_MS = 110 * 1000;

function createRendererApprovalPrompt({
  getWindow,
  createId = randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  /** approvalId → settle */
  const pending = new Map();

  const settle = (approvalId, decision) => {
    const entry = pending.get(approvalId);
    if (!entry) return false;
    pending.delete(approvalId);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    return true;
  };

  const send = (channel, payload) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return false;
    window.webContents.send(channel, payload);
    return true;
  };

  return {
    /** @returns {Promise<'once' | 'session' | 'deny'>} */
    prompt(request) {
      const approvalId = String(createId());
      if (!send('office:toolApproval', { approvalId, ...request })) {
        return Promise.resolve('deny');
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (settle(approvalId, 'deny')) {
            // The card would otherwise sit there offering an answer nobody
            // is waiting for any more.
            send('office:toolApprovalCleared', { approvalId });
          }
        }, timeoutMs);
        pending.set(approvalId, { resolve, timer });
      });
    },

    /** The renderer's answer. False when that question is already settled. */
    respond(approvalId, decision) {
      return settle(
        String(approvalId),
        decision === 'once' || decision === 'session' ? decision : 'deny',
      );
    },

    /** Refuse everything still open — the window went away, or the run ended. */
    clear() {
      for (const approvalId of [...pending.keys()]) settle(approvalId, 'deny');
    },
  };
}

module.exports = { createRendererApprovalPrompt, DEFAULT_TIMEOUT_MS };
