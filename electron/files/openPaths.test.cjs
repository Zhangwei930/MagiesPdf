const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const { documentPathsFromArgv, openableDocumentPath } = require('./openPaths.cjs');

const CWD = path.resolve('/work');
const packaged = (argv) => documentPathsFromArgv(argv, { isPackaged: true, cwd: CWD });
const fromSource = (argv) => documentPathsFromArgv(argv, { isPackaged: false, cwd: CWD });

describe('documentPathsFromArgv', () => {
  it('finds nothing when the app was launched on its own', () => {
    assert.deepEqual(packaged(['/Applications/MagiesPdf.app/Contents/MacOS/MagiesPdf']), []);
  });

  it('picks up a document passed to a packaged app', () => {
    assert.deepEqual(packaged(['/Applications/MagiesPdf', '/docs/report.pdf']), [
      path.resolve('/docs/report.pdf'),
    ]);
  });

  it('skips the app path electron adds when running from source', () => {
    // `electron . report.pdf` → [electron, appDir, report.pdf]
    assert.deepEqual(fromSource(['/bin/electron', '/work', '/docs/report.pdf']), [
      path.resolve('/docs/report.pdf'),
    ]);
  });

  it('never treats the executable itself as a document', () => {
    assert.deepEqual(packaged(['/Applications/Weird.pdf', '/docs/a.pdf']), [
      path.resolve('/docs/a.pdf'),
    ]);
  });

  it('ignores chromium and node switches', () => {
    assert.deepEqual(
      packaged(['/app', '--no-sandbox', '--inspect=9229', '-h', '/docs/a.pdf']),
      [path.resolve('/docs/a.pdf')],
    );
  });

  it('ignores files it cannot open', () => {
    assert.deepEqual(packaged(['/app', '/docs/notes.txt', '/docs/sheet.xlsx']), []);
  });

  it('matches the extension case-insensitively', () => {
    assert.deepEqual(packaged(['/app', '/docs/REPORT.PDF']), [path.resolve('/docs/REPORT.PDF')]);
  });

  it('resolves a relative path against the launching directory', () => {
    assert.deepEqual(packaged(['/app', 'sub/report.pdf']), [path.join(CWD, 'sub', 'report.pdf')]);
  });

  it('keeps several documents in the order they were given', () => {
    assert.deepEqual(packaged(['/app', '/docs/b.pdf', '/docs/a.pdf']), [
      path.resolve('/docs/b.pdf'),
      path.resolve('/docs/a.pdf'),
    ]);
  });

  it('drops a repeated path so one file cannot open twice', () => {
    assert.deepEqual(packaged(['/app', '/docs/a.pdf', '/docs/a.pdf']), [
      path.resolve('/docs/a.pdf'),
    ]);
  });

  it('survives junk in argv instead of throwing at startup', () => {
    assert.deepEqual(packaged(['/app', '', null, undefined, 42, '/docs/a.pdf']), [
      path.resolve('/docs/a.pdf'),
    ]);
    assert.deepEqual(documentPathsFromArgv(null, { isPackaged: true, cwd: CWD }), []);
  });
});

describe('openableDocumentPath', () => {
  it('accepts a PDF and returns it absolute', () => {
    assert.equal(openableDocumentPath('/docs/a.pdf', CWD), path.resolve('/docs/a.pdf'));
    assert.equal(openableDocumentPath('sub/a.pdf', CWD), path.join(CWD, 'sub', 'a.pdf'));
  });

  it('rejects anything the viewer cannot open', () => {
    assert.equal(openableDocumentPath('/docs/a.txt', CWD), '');
    assert.equal(openableDocumentPath('--flag', CWD), '');
    assert.equal(openableDocumentPath('', CWD), '');
    assert.equal(openableDocumentPath(undefined, CWD), '');
  });
});
