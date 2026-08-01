const path = require('node:path');
const { DOCUMENT_EXTENSIONS } = require('../office/formats.cjs');

/**
 * Documents named on the command line.
 *
 * Double-clicking a PDF on Windows and Linux, and `magiespdf report.pdf` from a
 * shell, both arrive as argv — and so does a second launch, which Electron hands
 * to the running instance as `second-instance`. macOS is the exception: there
 * the path arrives through the `open-file` event instead.
 *
 * argv is attacker-adjacent in the sense that anything can be in it, so this
 * reads rather than trusts: switches are dropped, the executable is never a
 * document, and only extensions the document workspace can actually open survive.
 */

const OPENABLE = DOCUMENT_EXTENSIONS;

/**
 * An absolute path if the viewer can open this candidate, or `''` if it cannot.
 * macOS delivers one path at a time through `open-file`, which is what this is
 * for; `documentPathsFromArgv` is the same rule applied across a command line.
 */
function openableDocumentPath(candidate, cwd) {
  if (typeof candidate !== 'string' || candidate === '' || candidate.startsWith('-')) return '';
  if (!OPENABLE.has(path.extname(candidate).toLowerCase())) return '';
  return path.resolve(typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd(), candidate);
}

function documentPathsFromArgv(argv, { isPackaged, cwd } = {}) {
  if (!Array.isArray(argv)) return [];

  // argv[0] is the executable. Running from source, Electron puts the app
  // directory in argv[1] as well — and that is not a document either.
  const start = isPackaged ? 1 : 2;

  const found = [];
  for (const entry of argv.slice(start)) {
    const absolute = openableDocumentPath(entry, cwd);
    // The same file listed twice would otherwise open twice.
    if (absolute !== '' && !found.includes(absolute)) found.push(absolute);
  }
  return found;
}

module.exports = { documentPathsFromArgv, openableDocumentPath, OPENABLE };
