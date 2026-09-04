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
    assert.match(viewerSource, /printPdf\(bytes, name, pageCount\)/);
    assert.match(preloadSource, /invoke\('app:printPdf', \{ bytes, name, pages \}\)/);
    assert.match(ipcSource, /pdfPrinter\.print\(bytes, \{/);
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
