const crypto = require('node:crypto');
const path = require('node:path');

const MAIN_WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
});

/**
 * The window a document is printed from.
 *
 * It is never shown and holds only a temp copy of the user's own document,
 * loaded off disk. `plugins` is what renders it: Chromium's built-in PDF
 * viewer is the thing that gets the page size, orientation and page count
 * right. Without it the window has nothing to print. Everything else stays as
 * closed as the main window — there is no preload here at all.
 */
const PRINT_WINDOW_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
  plugins: true,
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

/**
 * Schemes `shell.openExternal` may be handed.
 *
 * `openExternal` is the desktop's "open this the way the OS would", which on
 * every platform includes launching a registered handler. A `file:` url opens
 * a document — or an executable; a custom scheme reaches whatever application
 * claimed it. So the answer is not "a valid url" but "a url a browser would
 * have navigated to", which is these three and nothing else.
 */
const EXTERNAL_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function isExternalUrlAllowed(url) {
  if (typeof url !== 'string' || url === '') return false;
  try {
    return EXTERNAL_URL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
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
  PRINT_WINDOW_WEB_PREFERENCES,
  constantTimeTokenEqual,
  isExternalUrlAllowed,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  safeFileName,
};
