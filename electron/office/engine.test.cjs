const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { editorAssetsRoot, engineRoot, createEngineX2t } = require('./engine.cjs');

describe('document engine location', () => {
  it('reads the engine from the app resources once packaged', () => {
    assert.equal(
      engineRoot({ packaged: true, resourcesPath: '/app/Resources' }),
      path.join('/app/Resources', 'onlyoffice'),
    );
  });

  /**
   * In a checkout the engine is the unpacked vendor download, not in git, and
   * it is per platform because the converter is a native binary. The naming
   * matches the LibreOffice runtime beside it so both read the same way.
   */
  it('reads the engine for this platform from vendor during development', () => {
    assert.equal(
      engineRoot({ packaged: false, projectRoot: '/repo', platform: 'darwin', arch: 'arm64' }),
      path.join('/repo', 'vendor', 'onlyoffice', 'mac-arm64'),
    );
    assert.equal(
      engineRoot({ packaged: false, projectRoot: '/repo', platform: 'win32', arch: 'x64' }),
      path.join('/repo', 'vendor', 'onlyoffice', 'win-x64'),
    );
    assert.equal(
      engineRoot({ packaged: false, projectRoot: '/repo', platform: 'linux', arch: 'x64' }),
      path.join('/repo', 'vendor', 'onlyoffice', 'linux-x64'),
    );
  });
});

/**
 * The engine is one native converter and a great deal of javascript, and only
 * the converter differs between platforms. Keeping the javascript once rather
 * than once per target is the difference between a checkout carrying it five
 * times and carrying it once — and a packaged app composes the two back into
 * the single directory the runtime knows.
 */
describe('where the parts of the engine are', () => {
  it('takes the converter from the target being built for', () => {
    assert.equal(
      engineRoot({ packaged: false, projectRoot: '/repo', platform: 'win32', arch: 'arm64' }),
      path.join('/repo', 'vendor', 'onlyoffice', 'win-arm64'),
    );
  });

  it('takes everything else from the one copy of it', () => {
    assert.equal(
      editorAssetsRoot({ packaged: false, projectRoot: '/repo', platform: 'win32', arch: 'arm64' }),
      path.join('/repo', 'vendor', 'onlyoffice', 'shared', 'web'),
    );
  });

  /** Packaging composes both into one directory, so nothing splits at runtime. */
  it('finds both in the same place once packaged', () => {
    const options = { packaged: true, resourcesPath: '/app/Resources' };
    assert.equal(engineRoot(options), path.join('/app/Resources', 'onlyoffice'));
    assert.equal(editorAssetsRoot(options), path.join('/app/Resources', 'onlyoffice', 'web'));
  });
});

describe('the editor assets', () => {
  it('come from the browser build, not the converter\u2019s', () => {
    assert.equal(
      editorAssetsRoot({ packaged: true, resourcesPath: '/app/Resources' }),
      path.join('/app/Resources', 'onlyoffice', 'web'),
    );
  });

  it('are kept once, not once per target', () => {
    assert.equal(
      editorAssetsRoot({ packaged: false, projectRoot: '/repo', platform: 'darwin', arch: 'x64' }),
      path.join('/repo', 'vendor', 'onlyoffice', 'shared', 'web'),
    );
  });
});

describe('engine converter', () => {
  it('points the converter at the engine that shipped with it', () => {
    const built = createEngineX2t({ packaged: true, resourcesPath: '/app/Resources' });
    assert.equal(built.executablePath, path.join('/app/Resources', 'onlyoffice', 'converter', 'x2t'));
  });

  /**
   * The converter reads the fonts the editor is served. Pointed anywhere else
   * it still converts, but it rebuilds a .docx's font table on save from the
   * fonts it can find, and with none every font loses its panose — what Word
   * substitutes by when the reader does not have the font.
   */
  it('reads the fonts the editor is served', () => {
    const checkout = { packaged: false, projectRoot: '/repo', platform: 'win32', arch: 'arm64' };
    assert.equal(
      createEngineX2t(checkout).fontsDir,
      path.join('/repo', 'vendor', 'onlyoffice', 'shared', 'web', 'fonts'),
    );
    assert.equal(createEngineX2t(checkout).fontsDir, path.join(editorAssetsRoot(checkout), 'fonts'));

    const packaged = { packaged: true, resourcesPath: '/app/Resources' };
    assert.equal(createEngineX2t(packaged).fontsDir, path.join('/app/Resources', 'onlyoffice', 'web', 'fonts'));
  });

  /** Work directories hold copies of user documents; they belong in temp. */
  it('works inside the system temp directory', () => {
    const built = createEngineX2t({ packaged: false, projectRoot: '/repo' });
    assert.ok(built.tempRoot.startsWith(os.tmpdir()));
  });

  it('exposes the conversions the app needs', () => {
    const built = createEngineX2t({ packaged: false, projectRoot: '/repo' });
    for (const method of ['toEditorFormat', 'fromEditorFormat', 'discard']) {
      assert.equal(typeof built[method], 'function', `missing ${method}`);
    }
  });
});
