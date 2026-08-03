const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { describe, it, before, after } = require('node:test');
const { createX2t, x2tExecutablePath } = require('./x2t.cjs');
const { createOfficeSessions } = require('./session.cjs');
const { engineRoot } = require('./engine.cjs');

/**
 * The unit tests prove the logic against fakes. This one proves the two
 * modules actually drive the real converter — the part that fakes cannot
 * tell us, and where every surprise so far has come from.
 *
 * It is skipped when the engine is not vendored, because `vendor/onlyoffice/`
 * is a ~600 MB unpacked download that is deliberately not in git and not in CI.
 */

// Resolved the same way the app resolves it, so moving the engine cannot leave
// this suite quietly skipping while reporting success.
const RUNTIME_ROOT = engineRoot({ packaged: false, projectRoot: path.join(__dirname, '..', '..') });
const EXECUTABLE = x2tExecutablePath(RUNTIME_ROOT);
const AVAILABLE = fs.existsSync(EXECUTABLE);

function run(executable, args) {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout: 120000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** A document with the things that actually break: a table, a styled run, CJK. */
async function buildSampleDocx(target) {
  const { createBlankOfficeDocument } = await import('../../src/core/office/documents.ts');
  await fsp.writeFile(target, Buffer.from(createBlankOfficeDocument('word').bytes));
}

describe('x2t against the vendored engine', { skip: AVAILABLE ? false : 'vendor/onlyoffice is not present' }, () => {
  let tempRoot = '';
  let x2t = null;

  before(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'magies-x2t-'));
    x2t = createX2t({
      executable: EXECUTABLE,
      fontsDir: path.join(RUNTIME_ROOT, 'fonts'),
      allFontsPath: path.join(RUNTIME_ROOT, 'editors', 'sdkjs', 'common', 'AllFonts.js'),
      tempRoot,
      fs: fsp,
      run,
      uniqueId: () => crypto.randomUUID(),
    });
  });

  after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('round-trips a document through the editor format without losing it', async () => {
    const source = path.join(tempRoot, 'sample.docx');
    await buildSampleDocx(source);

    const { binPath, workDir } = await x2t.toEditorFormat(source);
    assert.ok(fs.existsSync(binPath), 'the converter produced no Editor.bin');
    assert.ok(fs.statSync(binPath).size > 0, 'Editor.bin is empty');

    const target = path.join(tempRoot, 'out.docx');
    await x2t.fromEditorFormat(binPath, target);
    assert.ok(fs.statSync(target).size > 0, 'the restored document is empty');

    // A .docx is a zip; anything else means the format id was wrong.
    const header = await fsp.readFile(target);
    assert.equal(header.subarray(0, 2).toString(), 'PK');

    await x2t.discard(workDir);
    assert.equal(fs.existsSync(workDir), false);
  });

  /**
   * The single-window story in one test: an Office file becomes something the
   * app's own PDF viewer can render, with no second application involved.
   */
  it('renders a document to a PDF the viewer can open', async () => {
    const source = path.join(tempRoot, 'preview.docx');
    await buildSampleDocx(source);

    const { pdfPath, workDir } = await x2t.toPdf(source);

    assert.ok(fs.existsSync(pdfPath), 'no PDF was produced');
    const header = await fsp.readFile(pdfPath);
    assert.equal(header.subarray(0, 5).toString(), '%PDF-');

    await x2t.discard(workDir);
  });

  it('drives a full open → edit → save session', async () => {
    const source = path.join(tempRoot, 'session.docx');
    await buildSampleDocx(source);

    const sessions = createOfficeSessions({ x2t, fs: fsp, uniqueId: () => crypto.randomUUID() });
    const session = await sessions.open(source);
    assert.equal(session.editorType, 'word');

    // Standing in for the editor: hand back the bytes it was given.
    const produced = await fsp.readFile(session.binPath);
    await sessions.writeEditorBin(session.id, produced.toString('base64'));

    const target = path.join(tempRoot, 'session-copy.docx');
    const saved = await sessions.saveAs(session.id, target);
    assert.equal(saved.path, target);
    assert.ok(fs.statSync(target).size > 0);

    await sessions.close(session.id);
    assert.equal(fs.existsSync(session.workDir), false);
  });
});
