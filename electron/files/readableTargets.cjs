'use strict';

const path = require('node:path');
const { normalizeTarget } = require('./writableTargets.cjs');

/**
 * The set of files the renderer is allowed to read.
 *
 * `files:read` used to take any absolute path the renderer named, and reading a
 * file also earned the right to overwrite it. Between them that meant a
 * renderer compromised by anything — a supply-chain dependency, a bug in the
 * assistant pane — could read whatever the process could reach and then write
 * over it. The comment on `writableTargets` promised the opposite: that a
 * compromised renderer could touch only the documents the user opened.
 *
 * So a path is readable only because the main process put it there, and it
 * does that in exactly four places, each of which is a real user action:
 *
 *   - a file chosen in an OS dialog the main process opened
 *   - a file dropped on the window (`webUtils` resolves a real `File`; a
 *     fabricated one yields nothing)
 *   - a document the user opened before, offered again from the recent list
 *   - a document handed to the app by the OS, through argv or "Open With"
 *
 * Knowing a path is not a capability. Being given one is.
 *
 * Kept apart from `writableTargets` so the two can be reasoned about
 * separately: opening a document is not the same permission as replacing it,
 * even though opening one does lead to the other.
 */

/** Enough for any real session; bounded so a long batch run cannot grow forever. */
const LIMIT = 1000;

/** Insertion-ordered, so the oldest entry is the first one a Map yields. */
const targets = new Map();

function grant(candidate) {
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

function grantAll(candidates) {
  if (!Array.isArray(candidates)) return;
  for (const candidate of candidates) grant(candidate);
}

function isReadable(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  const key = normalizeTarget(candidate);
  return key !== '' && targets.has(key);
}

/** Test seam; the app never forgets a target while it is running. */
function forgetAll() {
  targets.clear();
}

module.exports = { LIMIT, forgetAll, grant, grantAll, isReadable };
