const crypto = require('node:crypto');
const path = require('node:path');

const MAIN_WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
});

function safeFileName(name) {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    path.isAbsolute(name) ||
    path.posix.basename(name) !== name ||
    path.win32.basename(name) !== name ||
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  ) {
    throw new Error('A safe file name without directories is required');
  }
  return name;
}

function isTrustedRendererUrl(actualUrl, expectedUrl) {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    if (expected.protocol === 'file:') {
      return (
        actual.protocol === 'file:' &&
        actual.host === expected.host &&
        decodeURIComponent(actual.pathname) === decodeURIComponent(expected.pathname)
      );
    }
    return actual.origin === expected.origin;
  } catch {
    return false;
  }
}

function isTrustedIpcSender(event, window, expectedUrl) {
  if (
    !event?.sender ||
    !window ||
    window.isDestroyed?.() ||
    window.webContents?.isDestroyed?.() ||
    event.sender.id !== window.webContents?.id
  ) {
    return false;
  }
  const senderUrl = event.senderFrame?.url || event.sender.getURL?.();
  return isTrustedRendererUrl(senderUrl, expectedUrl);
}

function constantTimeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) {
    return false;
  }
  const providedDigest = crypto.createHash('sha256').update(provided).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest) && provided.length === expected.length;
}

module.exports = {
  MAIN_WINDOW_WEB_PREFERENCES,
  constantTimeTokenEqual,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  safeFileName,
};
