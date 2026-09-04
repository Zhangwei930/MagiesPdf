'use strict';

const path = require('node:path');

/**
 * Whether a chosen path can be run as the external converter.
 *
 * Picking a converter needs a path and nothing else, so this checks the file
 * rather than reading it — the old route went through `files:pick`, which
 * slurps the whole executable into memory and ships it across IPC, refuses
 * anything over 512 MiB, and hands the renderer overwrite rights on a binary
 * it has no business writing to.
 *
 * Returns null when the file will do, or a reason it will not.
 */

/** No execute bit exists on Windows; the extension is what says "runnable". */
const WINDOWS_EXECUTABLE = new Set(['.exe', '.bat', '.cmd', '.com']);

function executableProblem({ stat, path: candidate, platform = process.platform }) {
  if (!stat) return 'missing';
  // A macOS `.app` is a directory — the binary inside it is what runs.
  if (!stat.isFile()) return 'not-a-file';

  if (platform === 'win32') {
    return WINDOWS_EXECUTABLE.has(path.extname(String(candidate)).toLowerCase())
      ? null
      : 'not-executable';
  }

  // Any of user/group/other will do: what matters is that something can run it.
  return (stat.mode & 0o111) !== 0 ? null : 'not-executable';
}

module.exports = { executableProblem, WINDOWS_EXECUTABLE };
