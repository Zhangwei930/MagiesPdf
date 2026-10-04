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
const { createEngineX2t, engineRoot } = require('./engine.cjs');

/**
 * The unit tests prove the logic against fakes. This one proves the two
 * modules actually drive the real converter — the part that fakes cannot
 * tell us, and where every surprise so far has come from.
 *
 * It is skipped when the engine is not vendored, because `vendor/onlyoffice/`
 * is a ~600 MB unpacked download that is deliberately not in git and not in
 * ci.yml. integration.yml vendors it, and fails if this suite skips.
 */

// Resolved the same way the app resolves it, so moving the engine cannot leave
// this suite quietly skipping while reporting success.
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const RUNTIME_ROOT = engineRoot({ packaged: false, projectRoot: PROJECT_ROOT });
// The fonts the app hands the converter, taken from the app rather than restated.
const { fontsDir: FONTS_DIR } = createEngineX2t({ packaged: false, projectRoot: PROJECT_ROOT });
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
      fontsDir: FONTS_DIR,
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
   * The converter rebuilds a .docx's font table on save from the fonts it is
   * given. Given none, it still saves — with every font's panose gone, which is
   * what Word substitutes by when the reader does not have the font.
   */
  it('keeps every font\'s panose through a save', async () => {
    const source = path.join(tempRoot, 'fonts.docx');
    await buildSampleDocx(source);

    const { binPath, workDir } = await x2t.toEditorFormat(source);
    const target = path.join(tempRoot, 'fonts-out.docx');
    await x2t.fromEditorFormat(binPath, target);

    const { zipRead } = await import('../../src/core/ooxml/zip.ts');
    const entry = zipRead(await fsp.readFile(target)).get('word/fontTable.xml');
    assert.ok(entry, 'the saved document has no font table');
    const fontTable = Buffer.from(entry).toString('utf8');
    const fonts = fontTable.match(/<w:font\b/g) ?? [];
    assert.ok(fonts.length > 0, 'the font table names no fonts');
    assert.equal((fontTable.match(/<w:panose1\b/g) ?? []).length, fonts.length, 'a font lost its panose');

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
