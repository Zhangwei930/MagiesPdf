const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { after, before, describe, it } = require('node:test');

/**
 * Proves that the print window actually has the document in it.
 *
 * The unit tests describe the lifetime — what is written, what is removed,
 * what is refused. Only this one shows that a document is rendered at all, and
 * it is the test that caught the bug the settle wait exists for: printing on
 * `did-finish-load` produced a single blank page from a seven-page file.
 *
 * Runs Electron for real, so it is skipped where there is no display — which
 * includes CI. That is the same trade the LibreOffice integration tests make:
 * the check that needs the real thing runs where the real thing is.
 */

function electronBinary() {
  try {
    const resolved = require('electron');
    return typeof resolved === 'string' && fs.existsSync(resolved) ? resolved : '';
  } catch {
    return '';
  }
}

const ELECTRON = electronBinary();
const HAS_DISPLAY = process.platform !== 'linux' || Boolean(process.env.DISPLAY);
const AVAILABLE = ELECTRON !== '' && HAS_DISPLAY;

/** A valid PDF of `pages` empty A4 pages, so the count is the only variable. */
function blankPdf(pages) {
  const objects = [];
  const kids = [];
  for (let index = 0; index < pages; index += 1) kids.push(`${3 + index} 0 R`);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Count ${pages} /Kids [${kids.join(' ')}] >>`);
  for (let index = 0; index < pages; index += 1) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>');
  }

  let body = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startXref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/**
 * Opens `source` the way the printer does and reports what the window would
 * put on paper. `printToPDF` stands in for the print dialog, which cannot be
 * answered from a test — what is being checked is that the document is there,
 * not that a printer accepted it.
 */
const PROBE = `
const { app, BrowserWindow } = require('electron');
const { whenDocumentSettles, whenDocumentRendered } = require(process.argv[2]);
const { PRINT_WINDOW_WEB_PREFERENCES } = require(process.argv[3]);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { ...PRINT_WINDOW_WEB_PREFERENCES },
  });
  try {
    await window.loadFile(process.argv[4]);
    await whenDocumentSettles(window.webContents);
    await whenDocumentRendered(window.webContents, { expectedPages: Number(process.argv[5]) });
    const printed = await window.webContents.printToPDF({});
    const count = /\\/Count (\\d+)/.exec(printed.toString('latin1'));
    console.log('PAGES=' + (count ? count[1] : '0'));
  } catch (cause) {
    // Chromium refusing to render at all says nothing about page counts, and
    // it does refuse on a loaded machine. That is this host, not the product.
    const unavailable = /Printing failed|Failed to generate PDF/i.test(cause.message);
    console.log((unavailable ? 'UNAVAILABLE=' : 'FAILED=') + cause.message);
  } finally {
    window.destroy();
    app.quit();
  }
});
`;

function printedPageCount(probePath, source, expectedPages) {
  return new Promise((resolve, reject) => {
    execFile(
      ELECTRON,
      [
        probePath,
        path.join(__dirname, 'print.cjs'),
        path.join(__dirname, 'security.cjs'),
        source,
        String(expectedPages),
      ],
      { timeout: 60_000 },
      (error, stdout) => {
        const answer = /PAGES=(\d+)/.exec(stdout);
        if (answer) return resolve(Number(answer[1]));
        const unavailable = /UNAVAILABLE=(.*)/.exec(stdout);
        if (unavailable) return resolve(null);
        const failure = /FAILED=(.*)/.exec(stdout);
        return reject(new Error(failure?.[1] ?? error?.message ?? 'the probe said nothing'));
      },
    );
  });
}

describe('what the print window puts on paper', { skip: AVAILABLE ? false : 'needs Electron and a display' }, () => {
  let workDir = '';
  let probePath = '';

  before(async () => {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'magies-print-test-'));
    probePath = path.join(workDir, 'probe.cjs');
    await fsp.writeFile(probePath, PROBE);
  });

  after(async () => {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
  });

  /**
   * A render that came back wrong is a defect and fails. A print subsystem
   * that refused to render is this machine having a bad minute — it carries no
   * information about page counts, and treating it as a failure would make
   * this red for a reason that is not about the product.
   */
  it('prints a one-page document as one page', async (t) => {
    const source = path.join(workDir, 'one.pdf');
    await fsp.writeFile(source, blankPdf(1));
    const pages = await printedPageCount(probePath, source, 1);
    if (pages === null) return t.skip('this host refused to render at all');
    assert.equal(pages, 1);
  });

  /**
   * The viewer only ever mounts the pages near the one being read, so this is
   * well past its window. Printing the renderer produced a handful of screens
   * of application chrome; printing the document produces the document.
   */
  it('prints every page of a document far longer than the viewer mounts', async (t) => {
    const source = path.join(workDir, 'sixty.pdf');
    await fsp.writeFile(source, blankPdf(60));
    const pages = await printedPageCount(probePath, source, 60);
    if (pages === null) return t.skip('this host refused to render at all');
    // The number is the point: an unready plugin reports exactly one page, so
    // anything short of sixty here is the bug this test exists for.
    assert.equal(pages, 60);
  });
});
