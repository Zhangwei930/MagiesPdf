const path = require('node:path');

/**
 * The set of files the renderer is allowed to overwrite in place.
 *
 * Saving over the file you opened is the one operation where the renderer names
 * a destination on disk, which makes it the most dangerous handler in the app:
 * validating the *shape* of a path proves nothing, since every path is well
 * formed. So this is a capability list instead — a path becomes writable only
 * because the main process itself put the contents in the renderer's hands, by
 * reading the file or by writing it through a save dialog the user confirmed.
 *
 * A renderer that has been compromised can therefore overwrite the documents
 * the user opened this session, and nothing else.
 */

/** Enough for any real session; bounded so a long batch run cannot grow forever. */
const LIMIT = 1000;

/** Insertion-ordered, so the oldest entry is the first one a Map yields. */
const targets = new Map();

/**
 * A path in the one spelling this list compares. Windows and macOS treat two
 * casings as the same file, so folding case there is what makes the check
 * match what the filesystem will actually do.
 */
function normalizeTarget(candidate, platform = process.platform) {
  if (typeof candidate !== 'string' || candidate === '') return '';
  const resolved = path.resolve(candidate);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function remember(candidate) {
  const key = normalizeTarget(candidate);
  if (key === '') return;

  // Re-inserting moves the entry to the back, so a file still in use is not the
  // one evicted when the cap is reached.
  targets.delete(key);
  targets.set(key, true);

  while (targets.size > LIMIT) {
    const oldest = targets.keys().next().value;
    targets.delete(oldest);
  }
}

function rememberAll(candidates) {
  if (!Array.isArray(candidates)) return;
  for (const candidate of candidates) remember(candidate);
}

function isWritable(candidate) {
  const key = normalizeTarget(candidate);
  return key !== '' && targets.has(key);
}

/** Test seam; the app never forgets a target while it is running. */
function forgetAll() {
  targets.clear();
}

module.exports = { LIMIT, forgetAll, isWritable, normalizeTarget, remember, rememberAll };
