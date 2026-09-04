const path = require('node:path');
const { safeFileName } = require('./security.cjs');

/**
 * Printing a PDF.
 *
 * The obvious call — `webContents.print()` on the window the user is looking
 * at — prints the window: the title bar, the toolbar, the sidebar, the AI
 * panel, and only the pages the viewer's virtualization happened to have
 * mounted. A hundred-page document printed as three pages of application
 * chrome (issue #27).
 *
 * So the document is written out and opened, on its own, in a window nobody
 * sees, and *that* is printed. What renders it is Chromium's own PDF viewer,
 * which is why the page size, the orientation and the page count are right
 * without this file knowing anything about any of them.
 *
 * The bytes come from the renderer rather than from disk, deliberately: what
 * is printed is the document the tab is showing, including edits that have not
 * been saved. That also makes them untrusted input, which is what the checks
 * below are for. No path is accepted here at all.
 *
 * Everything that touches Electron or the filesystem is injected, so the
 * lifetime — and the removal of a temp copy of the user's document — is tested
 * without a display or a printer.
 */

/**
 * How long the print window has to stay quiet before the document is taken to
 * be there.
 *
 * Loading a PDF finishes well before the PDF can be printed. Measured on a
 * seven-page document: `did-finish-load` at 179ms, and printing then produces
 * a single blank page; the viewer starts a load of its own, stops again at
 * 468ms, and only ~150ms after that does the whole document print. Nothing
 * announces that last step — there is no event for "the plugin has the
 * document" — so what is waited for is the page going quiet and staying quiet.
 *
 * Generously above what was measured, because printing half a second late is
 * invisible next to the print dialog that follows, and printing early is a
 * blank page.
 */
const PLUGIN_SETTLE_MS = 500;

/** ...but a viewer that never settles must not mean a document that never prints. */
const PLUGIN_READY_TIMEOUT_MS = 10_000;

/** Larger than any PDF a person prints, and far smaller than renderer memory. */
const MAX_PRINTABLE_BYTES = 512 * 1024 * 1024;

const PDF_MAGIC = '%PDF-';

const REAL_CLOCK = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function isPdfBytes(bytes) {
  if (!bytes || typeof bytes === 'string' || typeof bytes.byteLength !== 'number') return false;
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  return Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, PDF_MAGIC.length)
    .toString('latin1') === PDF_MAGIC;
}

/**
 * The name the temp copy takes, which is the name the print job takes: the
 * page's title is the file name, and Chromium names the job after the page.
 * A document called `报告.pdf` should not queue up as `document.pdf`.
 */
function printableFileName(name) {
  try {
    const safe = safeFileName(typeof name === 'string' ? name.trim() : '');
    return path.extname(safe).toLowerCase() === '.pdf' ? safe : `${safe}.pdf`;
  } catch {
    return 'document.pdf';
  }
}

/** Anything that starts more work restarts the wait. */
const LOADING_EVENTS = ['did-start-loading', 'did-stop-loading', 'frame-created'];

/**
 * Resolves once the print window has stopped loading things for a while — see
 * `PLUGIN_SETTLE_MS` for why that is the signal and not `did-finish-load`.
 *
 * Never rejects: the worst outcome here is printing a moment early, which is
 * still better than refusing to print.
 */
function whenDocumentSettles(contents, options = {}) {
  const {
    clock = REAL_CLOCK,
    settleMs = PLUGIN_SETTLE_MS,
    timeoutMs = PLUGIN_READY_TIMEOUT_MS,
  } = options;

  return new Promise((resolve) => {
    let settle = null;
    const finish = () => {
      if (settle !== null) clock.clearTimeout(settle);
      clock.clearTimeout(cap);
      for (const event of LOADING_EVENTS) contents.off(event, restart);
      resolve();
    };
    function restart() {
      if (settle !== null) clock.clearTimeout(settle);
      settle = clock.setTimeout(finish, settleMs);
    }
    const cap = clock.setTimeout(finish, timeoutMs);
    for (const event of LOADING_EVENTS) contents.on(event, restart);
    restart();
  });
}

/**
 * How often the window is asked whether it has the document yet, and how many
 * times at most.
 *
 * Each probe is a real render, so this is not free. Asking every 150ms for ten
 * seconds — sixty-six renders — made Chromium's print subsystem itself fail
 * ("Failed to generate PDF: Printing failed") on a machine under load, which
 * traded a blank page for no page at all. A handful of probes, spaced out, is
 * enough: the gap being waited for is a few hundred milliseconds.
 */
const RENDER_PROBE_MS = 500;
const MAX_RENDER_PROBES = 8;

/**
 * The page count of a PDF this code produced — never of the user's document.
 *
 * The only bytes parsed here come from `printToPDF`, which writes a plain
 * uncompressed page tree, so the count is in the text. A user's PDF may keep
 * its catalogue in an object stream where none of this is visible, which is
 * why the *expected* count comes from the renderer instead: pdf.js has already
 * laid the document out and knows.
 */
function renderedPageCount(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((match) => Number(match[1]));
  return counts.length > 0 ? Math.max(...counts) : 0;
}

/**
 * Resolves once the window has the document, not merely once it has stopped
 * loading.
 *
 * Settling was a timing heuristic — quiet for 500ms — and on a loaded machine
 * the plugin needs longer than that, so a sixty-page document printed as one
 * blank page. This asks instead: `printToPDF` reports a single blank page
 * until the plugin has parsed the document, and the real count once it has.
 *
 * Never rejects, and never waits past its deadline: printing a moment early is
 * bad, and refusing to print at all is worse.
 *
 * The blind spot is a one-page document, where an unready plugin and a
 * finished render both report 1. Those fall back to the settle window, which
 * is what every document had before this.
 */
async function whenDocumentRendered(contents, options = {}) {
  const {
    expectedPages = 0,
    clock = REAL_CLOCK,
    probeIntervalMs = RENDER_PROBE_MS,
    timeoutMs = PLUGIN_READY_TIMEOUT_MS,
  } = options;

  // Nothing to check against — the caller could not say how many pages the
  // document has, so there is no question to ask.
  if (!Number.isInteger(expectedPages) || expectedPages < 2) return;

  const deadline = new Promise((resolve) => {
    clock.setTimeout(() => resolve('deadline'), timeoutMs);
  });
  let expired = false;
  void deadline.then(() => {
    expired = true;
  });

  for (let probe = 0; probe < MAX_RENDER_PROBES && !expired; probe += 1) {
    let rendered = 0;
    try {
      rendered = renderedPageCount(await contents.printToPDF({}));
    } catch {
      // The window cannot answer — under load the print subsystem itself can
      // refuse. Asking again would only add to what it is already struggling
      // with, so stop and let the print attempt speak for itself.
      return;
    }
    if (rendered >= expectedPages) return;
    await Promise.race([
      new Promise((resolve) => {
        clock.setTimeout(resolve, probeIntervalMs);
      }),
      deadline,
    ]);
  }
}

function createPdfPrinter({ writeTemp, removeTemp, openWindow }) {
  return {
    /**
     * @param {Uint8Array} bytes the document as the tab currently has it
     * @returns {Promise<{ printed: boolean, reason?: string }>}
     */
    async print(bytes, { name, pages = 0 } = {}) {
      if (!isPdfBytes(bytes)) throw new Error('Not a PDF: refusing to print');
      if (bytes.byteLength > MAX_PRINTABLE_BYTES) {
        throw new Error('The document is too large to print');
      }

      const { path: filePath, directory } = await writeTemp(bytes, printableFileName(name));
      let window = null;
      try {
        window = await openWindow(filePath, { expectedPages: pages });
        // Not silent: choosing the printer, the range and the copies is the
        // print dialog's job, and the OS already has one.
        return await window.print({ silent: false, printBackground: true });
      } finally {
        window?.destroy();
        // The copy is the user's document, decrypted. It goes whether the job
        // printed, failed, or the dialog was simply dismissed.
        await removeTemp(directory);
      }
    },
  };
}

module.exports = {
  createPdfPrinter,
  whenDocumentRendered,
  renderedPageCount,
  printableFileName,
  whenDocumentSettles,
  MAX_PRINTABLE_BYTES,
  PLUGIN_SETTLE_MS,
  PLUGIN_READY_TIMEOUT_MS,
};
