const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createX2t,
  documentFormatId,
  editorFormatId,
  x2tExecutablePath,
} = require('./x2t.cjs');

function dependencies(overrides = {}) {
  const calls = { ran: [], written: [], removed: [] };
  const deps = {
    executable: '/engine/converter/x2t',
    fontsDir: '/engine/fonts',
    tempRoot: '/tmp/magies',
    fs: {
      mkdir: async (target) => calls.written.push(['mkdir', target]),
      writeFile: async (target, contents) => calls.written.push([target, contents]),
      rm: async (target) => calls.removed.push(target),
      access: async () => undefined,
    },
    run: async (executable, args) => {
      calls.ran.push([executable, args]);
      return { code: 0 };
    },
    uniqueId: () => 'job1',
    ...overrides,
  };
  return { calls, deps };
}

describe('x2t format ids', () => {
  it('maps every document extension the suite opens', () => {
    assert.equal(documentFormatId('/a/b.docx'), 65);
    assert.equal(documentFormatId('/a/b.doc'), 66);
    assert.equal(documentFormatId('/a/b.odt'), 67);
    assert.equal(documentFormatId('/a/b.rtf'), 68);
    assert.equal(documentFormatId('/a/b.xlsx'), 257);
    assert.equal(documentFormatId('/a/b.xls'), 258);
    assert.equal(documentFormatId('/a/b.ods'), 259);
    assert.equal(documentFormatId('/a/b.pptx'), 129);
    assert.equal(documentFormatId('/a/b.ppt'), 130);
    assert.equal(documentFormatId('/a/b.odp'), 131);
    assert.equal(documentFormatId('/a/b.pdf'), 513);
  });

  it('is case insensitive and rejects anything else', () => {
    assert.equal(documentFormatId('/a/B.DOCX'), 65);
    assert.equal(documentFormatId('/a/b.exe'), 0);
    assert.equal(documentFormatId('/a/b'), 0);
  });

  /**
   * The editor edits one internal format per document kind. Picking the wrong
   * one silently produces a file the editor cannot open, so it is pinned here.
   */
  it('maps a document to the editor canvas format its editor uses', () => {
    assert.equal(editorFormatId('/a/b.docx'), 8193);
    assert.equal(editorFormatId('/a/b.rtf'), 8193);
    assert.equal(editorFormatId('/a/b.xlsx'), 8194);
    assert.equal(editorFormatId('/a/b.ods'), 8194);
    assert.equal(editorFormatId('/a/b.pptx'), 8195);
    assert.equal(editorFormatId('/a/b.odp'), 8195);
    assert.equal(editorFormatId('/a/b.zip'), 0);
  });
});

describe('x2t executable path', () => {
  it('points at the bundled converter per platform', () => {
    assert.equal(x2tExecutablePath('/root', 'darwin'), '/root/converter/x2t');
    assert.equal(x2tExecutablePath('/root', 'linux'), '/root/converter/x2t');
    assert.equal(x2tExecutablePath('/root', 'win32'), '/root/converter/x2t.exe');
  });
});

describe('x2t conversion', () => {
  it('converts a document into the editor format', async () => {
    const { calls, deps } = dependencies();
    const x2t = createX2t(deps);

    const result = await x2t.toEditorFormat('/docs/report.docx');

    assert.equal(result.binPath, '/tmp/magies/job1/Editor.bin');
    assert.equal(result.workDir, '/tmp/magies/job1');
    const [paramsPath, paramsXml] = calls.written.find(([target]) => String(target).endsWith('.xml'));
    assert.equal(paramsPath, '/tmp/magies/job1/params.xml');
    assert.match(paramsXml, /<m_sFileFrom>\/docs\/report\.docx<\/m_sFileFrom>/);
    assert.match(paramsXml, /<m_sFileTo>\/tmp\/magies\/job1\/Editor\.bin<\/m_sFileTo>/);
    assert.match(paramsXml, /<m_nFormatTo>8193<\/m_nFormatTo>/);
    assert.match(paramsXml, /<m_sFontDir>\/engine\/fonts<\/m_sFontDir>/);
    assert.deepEqual(calls.ran, [['/engine/converter/x2t', ['/tmp/magies/job1/params.xml']]]);
  });

  it('converts the editor format back to a document', async () => {
    const { calls, deps } = dependencies();
    const x2t = createX2t(deps);

    await x2t.fromEditorFormat('/tmp/magies/job1/Editor.bin', '/docs/report.docx');

    const [, paramsXml] = calls.written.find(([target]) => String(target).endsWith('.xml'));
    assert.match(paramsXml, /<m_sFileFrom>\/tmp\/magies\/job1\/Editor\.bin<\/m_sFileFrom>/);
    assert.match(paramsXml, /<m_sFileTo>\/docs\/report\.docx<\/m_sFileTo>/);
    assert.match(paramsXml, /<m_nFormatTo>65<\/m_nFormatTo>/);
  });

  /**
   * Every path here arrives from the renderer, so the converter is a trust
   * boundary in its own right — not only the IPC handler that calls it.
   */
  it('refuses a relative path', async () => {
    const { deps } = dependencies();
    const x2t = createX2t(deps);
    await assert.rejects(() => x2t.toEditorFormat('docs/report.docx'), /absolute/i);
  });

  it('refuses a format the suite does not open', async () => {
    const { deps } = dependencies();
    const x2t = createX2t(deps);
    await assert.rejects(() => x2t.toEditorFormat('/docs/report.exe'), /unsupported/i);
  });

  it('refuses to write a document the suite cannot produce', async () => {
    const { deps } = dependencies();
    const x2t = createX2t(deps);
    await assert.rejects(
      () => x2t.fromEditorFormat('/tmp/magies/job1/Editor.bin', '/docs/report.exe'),
      /unsupported/i,
    );
  });

  it('surfaces a converter failure instead of reporting success', async () => {
    const { deps } = dependencies({ run: async () => ({ code: 1, stderr: 'boom' }) });
    const x2t = createX2t(deps);
    await assert.rejects(() => x2t.toEditorFormat('/docs/report.docx'), /x2t failed/i);
  });

  /**
   * Rendering to PDF is how an Office document is shown in the app's own
   * viewer, so it is the whole single-window story — not an export nicety.
   */
  it('renders a document to PDF for the viewer', async () => {
    const { calls, deps } = dependencies();
    const x2t = createX2t(deps);

    const result = await x2t.toPdf('/docs/report.docx');

    assert.equal(result.pdfPath, '/tmp/magies/job1/preview.pdf');
    const [, paramsXml] = calls.written.find(([target]) => String(target).endsWith('.xml'));
    assert.match(paramsXml, /<m_nFormatTo>513<\/m_nFormatTo>/);
    assert.match(paramsXml, /<m_sFileTo>\/tmp\/magies\/job1\/preview\.pdf<\/m_sFileTo>/);
  });

  /**
   * PDF goes through DoctRenderer, which will not start without the font
   * manifest. Leaving it out of the params is the difference between a
   * rendered page and a silent failure, so it is pinned here.
   */
  it('tells the renderer where the font manifest is when producing PDF', async () => {
    const { calls, deps } = dependencies({ allFontsPath: '/engine/AllFonts.js' });
    const x2t = createX2t(deps);

    await x2t.toPdf('/docs/report.docx');

    const [, paramsXml] = calls.written.find(([target]) => String(target).endsWith('.xml'));
    assert.match(paramsXml, /<m_sAllFontsPath>\/engine\/AllFonts\.js<\/m_sAllFontsPath>/);
  });

  it('refuses to render a format it cannot read', async () => {
    const { deps } = dependencies();
    const x2t = createX2t(deps);
    await assert.rejects(() => x2t.toPdf('/docs/report.exe'), /unsupported/i);
  });

  it('cleans up a work directory on request', async () => {
    const { calls, deps } = dependencies();
    const x2t = createX2t(deps);
    await x2t.discard('/tmp/magies/job1');
    assert.deepEqual(calls.removed, ['/tmp/magies/job1']);
  });

  it('refuses to clean up anything outside its own temp root', async () => {
    const { deps } = dependencies();
    const x2t = createX2t(deps);
    await assert.rejects(() => x2t.discard('/Users/someone/Documents'), /temp/i);
  });
});
