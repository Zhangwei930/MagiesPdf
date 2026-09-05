import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const viewerSource = readFileSync(new URL('./Viewer.tsx', import.meta.url), 'utf8');
const ipcSource = readFileSync(new URL('../../../electron/ipc.cjs', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../../../electron/preload.cjs', import.meta.url), 'utf8');

/**
 * Issue #27. Printing called `event.sender.print()` from the toolbar and the
 * shortcut, and `window.print()` from the file menu. Both printed the
 * renderer: the title bar, the toolbar, the sidebar, the AI panel — and only
 * the pages the viewer's virtualization had mounted, so a long document came
 * out as a few screens of application chrome.
 */
describe('printing wiring', () => {
  it('never prints the window', () => {
    assert.doesNotMatch(viewerSource, /window\.print\(\)/);
    assert.doesNotMatch(ipcSource, /sender\.print\(\)/);
  });

  it('sends the document the tab is showing, bytes and all', () => {
    assert.match(viewerSource, /printPdf\(printable, name, pageCount\)/);
    assert.match(preloadSource, /invoke\('app:printPdf', \{ bytes, name, pages \}\)/);
    assert.match(ipcSource, /pdfPrinter\.print\(bytes, \{/);
  });

  /**
   * Printing hands the document to a separate Chromium PDF viewer in the main
   * process, which opens the file itself and has no password to give it.
   *
   * Unlocking a document in this viewer only tells pdf.js the password — the
   * bytes the tab holds are still the encrypted file. So a document the user
   * had open and was reading printed nothing at all ("Printing failed"). The
   * unlocked copy has to be made here, which is where the password is.
   */
  it('hands the print path bytes it can actually open', () => {
    const body = /const print = useCallback\([\s\S]{0,1400}/.exec(viewerSource)?.[0];

    assert.ok(body, 'the print callback moved; this test needs updating');
    assert.match(body, /if \(password\)/, 'the password is not consulted before printing');
    assert.match(body, /security\.remove-password/, 'nothing decrypts the bytes');
    assert.ok(
      body.indexOf('security.remove-password') < body.indexOf('printPdf('),
      'the decryption has to happen before the print',
    );
  });

  /** The decrypted copy is for the print, not for the document. */
  it('does not write the decrypted copy back into the document', () => {
    const body = /const print = useCallback\([\s\S]{0,1400}/.exec(viewerSource)?.[0] ?? '';
    assert.doesNotMatch(body, /editDocument\(/);
  });

  /**
   * The keyboard shortcut, the toolbar button and the file menu were three
   * different implementations of one action; two of them were wrong in the
   * same way and one was wrong differently.
   */
  it('routes all three entry points through one function', () => {
    assert.equal(viewerSource.match(/void print\(\)/g)?.length, 3);
    assert.doesNotMatch(viewerSource, /bridge\(\)\.printPdf\(\)/);
  });

  it('renders the document with the PDF viewer, in a window nobody sees', () => {
    assert.match(ipcSource, /PRINT_WINDOW_WEB_PREFERENCES/);
    assert.match(ipcSource, /show: false/);
  });

  it('tells the user when printing failed instead of doing nothing', () => {
    assert.match(viewerSource, /viewerPrintFailed/);
  });

  /**
   * Waiting for the window to go quiet was a timing assumption, and on a busy
   * machine it was wrong: a sixty-page document printed as one blank page. The
   * count the viewer already knows turns that assumption into a check.
   */
  it('waits until the window has rendered every page, not just until it is quiet', () => {
    assert.match(ipcSource, /whenDocumentRendered/);
    assert.match(ipcSource, /expectedPages/);
  });
});
