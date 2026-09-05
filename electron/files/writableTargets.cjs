const fs = require('node:fs');
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

/** What the filesystem itself calls this path, or '' when it cannot say. */
function canonical(resolved, realpath) {
  try {
    return realpath(resolved);
  } catch {
    // Not there yet — a save-as destination. Its directory usually is, and
    // that is what decides how the name will be compared.
    try {
      return path.join(realpath(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return '';
    }
  }
}

/**
 * A path in the one spelling this list compares.
 *
 * Windows folds case, so folding is what makes the check match the filesystem.
 * macOS usually does — but an APFS volume can be case-sensitive, and there
 * folding is a *widening*: a grant for `/docs/A.pdf` would also permit writing
 * `/docs/a.pdf`, a different file the user never chose. Knowing a path must
 * not be enough, which is the whole point of this list.
 *
 * So macOS asks the filesystem instead of assuming. Where the volume folds
 * case, `realpath` answers with the name the file was created under whichever
 * spelling it was given, and both grants land on the same key; where it does
 * not, they stay apart. If the filesystem cannot answer at all the old
 * assumption is kept, because refusing to save on a path we cannot resolve
 * would break the ordinary case to guard a rare one.
 */
function normalizeTarget(candidate, options = {}) {
  const { platform = process.platform, realpath = fs.realpathSync.native } = options;
  if (typeof candidate !== 'string' || candidate === '') return '';
  const resolved = path.resolve(candidate);
  if (platform === 'win32') return resolved.toLowerCase();
  if (platform !== 'darwin') return resolved;
  return canonical(resolved, realpath) || resolved.toLowerCase();
}

function remember(candidate, options) {
  const key = normalizeTarget(candidate, options);
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

function isWritable(candidate, options) {
  const key = normalizeTarget(candidate, options);
  return key !== '' && targets.has(key);
}

/** Test seam; the app never forgets a target while it is running. */
function forgetAll() {
  targets.clear();
}

module.exports = { LIMIT, forgetAll, isWritable, normalizeTarget, remember, rememberAll };
