const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { describe, it, before, after } = require('node:test');
const { createLibreOfficeRenderer } = require('./libreOfficeRender.cjs');
const { createOfficePreview } = require('./preview.cjs');
const { officeRuntimeRoot, bundledLibreOfficeExecutable } = require('./libreOffice.cjs');

/**
 * Proves the preview path against the real renderer.
 *
 * The unit tests describe how the arguments are built; only this one shows
 * that those arguments actually produce a PDF. Skipped when the runtime is not
 * vendored, because it is a large download that is deliberately not in git.
 */

const RUNTIME_ROOT = officeRuntimeRoot({
  packaged: false,
  projectRoot: path.join(__dirname, '..', '..'),
});
const EXECUTABLE = bundledLibreOfficeExecutable(RUNTIME_ROOT);
const AVAILABLE = fs.existsSync(EXECUTABLE);

function run(executable, args, { timeout } = {}) {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout: timeout ?? 120000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('preview against the bundled renderer', {
  skip: AVAILABLE ? false : 'vendor/office-runtime is not present',
}, () => {
  let tempRoot = '';
  let renderer = null;

  before(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'magies-render-'));
    renderer = createLibreOfficeRenderer({
      executable: EXECUTABLE,
      tempRoot,
      fs: fsp,
      run,
      uniqueId: () => crypto.randomUUID(),
    });
  });

  after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('turns a real document into a PDF the viewer can open', async () => {
    const { createBlankOfficeDocument } = await import('../../src/core/office/documents.ts');
    const source = path.join(tempRoot, 'sample.docx');
    await fsp.writeFile(source, Buffer.from(createBlankOfficeDocument('word').bytes));

    const { pdfPath, workDir } = await renderer.toPdf(source);

    assert.ok(fs.existsSync(pdfPath), 'no PDF was produced');
    const header = await fsp.readFile(pdfPath);
    assert.equal(header.subarray(0, 5).toString(), '%PDF-');

    await renderer.discard(workDir);
    assert.equal(fs.existsSync(workDir), false);
  });

  /** End to end: the shape the renderer hands the tab strip. */
  it('produces bytes that carry their source and no path to overwrite', async () => {
    const { createBlankOfficeDocument } = await import('../../src/core/office/documents.ts');
    const source = path.join(tempRoot, 'preview.xlsx');
    await fsp.writeFile(source, Buffer.from(createBlankOfficeDocument('sheet').bytes));

    const preview = createOfficePreview({ x2t: renderer, fs: fsp });
    const [file] = await preview.render([source]);

    assert.equal(file.name, 'preview.xlsx');
    assert.equal(file.path, '');
    assert.deepEqual(file.origin, { path: source, kind: 'sheet' });
    assert.equal(Buffer.from(file.bytes).subarray(0, 5).toString(), '%PDF-');
  });
});
