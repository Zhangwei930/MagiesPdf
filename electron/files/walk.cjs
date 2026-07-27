const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Collect files under a directory for batch tools.
 *
 * Pure-ish Node helpers (no Electron) so they can be unit-tested.
 */

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_DEPTH = 8;

/**
 * @param {string} root Absolute directory path.
 * @param {{
 *   accept?: string[],
 *   recursive?: boolean,
 *   maxFiles?: number,
 *   maxDepth?: number,
 * }} [options]
 * @returns {Promise<string[]>} Absolute file paths, sorted.
 */
async function collectFilePaths(root, options = {}) {
  const accept = (options.accept ?? ['.pdf']).map((ext) =>
    ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`,
  );
  const recursive = options.recursive !== false;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const found = [];

  async function walk(dir, depth) {
    if (found.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      if (entry.name.startsWith('.')) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < maxDepth) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!accept.includes(ext)) continue;
      found.push(full);
    }
  }

  await walk(root, 0);
  return found;
}

module.exports = {
  collectFilePaths,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_DEPTH,
};
