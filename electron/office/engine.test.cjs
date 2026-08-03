const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { engineRoot, createEngineX2t } = require('./engine.cjs');

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

describe('engine converter', () => {
  it('points the converter at the engine that shipped with it', () => {
    const built = createEngineX2t({ packaged: true, resourcesPath: '/app/Resources' });
    assert.equal(built.executablePath, path.join('/app/Resources', 'onlyoffice', 'converter', 'x2t'));
  });

  /**
   * PDF rendering silently produces nothing without the font manifest, so the
   * converter must always be told where it is.
   */
  it('always knows where the font manifest is', () => {
    const built = createEngineX2t({ packaged: true, resourcesPath: '/app/Resources' });
    assert.equal(
      built.allFontsPath,
      path.join('/app/Resources', 'onlyoffice', 'editors', 'sdkjs', 'common', 'AllFonts.js'),
    );
  });

  /** Work directories hold copies of user documents; they belong in temp. */
  it('works inside the system temp directory', () => {
    const built = createEngineX2t({ packaged: false, projectRoot: '/repo' });
    assert.ok(built.tempRoot.startsWith(os.tmpdir()));
  });

  it('exposes the conversions the app needs', () => {
    const built = createEngineX2t({ packaged: false, projectRoot: '/repo' });
    for (const method of ['toPdf', 'toEditorFormat', 'fromEditorFormat', 'discard']) {
      assert.equal(typeof built[method], 'function', `missing ${method}`);
    }
  });
});
