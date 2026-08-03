import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  assertOfficeRuntime,
  officeRuntimeSource,
  assertDocumentEngine,
  documentEngineSource,
} = require('./officePackaging.cjs');

describe('document engine packaging', () => {
  it('selects the engine matching the package target', () => {
    assert.equal(
      documentEngineSource('/repo', 'darwin', 'arm64'),
      '/repo/vendor/onlyoffice/mac-arm64',
    );
    assert.equal(documentEngineSource('/repo', 'win32', 'x64'), '/repo/vendor/onlyoffice/win-x64');
    assert.equal(documentEngineSource('/repo', 'linux', 'x64'), '/repo/vendor/onlyoffice/linux-x64');
  });

  /**
   * Without the engine an installed app looks fine until someone opens a Word
   * file, so packaging has to refuse rather than ship a build that cannot.
   */
  it('fails packaging when the converter is absent', () => {
    assert.throws(
      () => assertDocumentEngine({ projectRoot: '/repo', platform: 'darwin', arch: 'x64', exists: () => false }),
      /prepare:engine/,
    );
  });

  /**
   * PDF rendering runs through DoctRenderer, which silently produces nothing
   * without the font manifest — so its absence must fail the build too.
   */
  it('fails packaging when the font manifest is absent', () => {
    const missingManifest = (candidate) => !candidate.endsWith('AllFonts.js');
    assert.throws(
      () => assertDocumentEngine({ projectRoot: '/repo', platform: 'darwin', arch: 'x64', exists: missingManifest }),
      /AllFonts/,
    );
  });

  it('accepts a complete engine', () => {
    assert.equal(
      assertDocumentEngine({ projectRoot: '/repo', platform: 'linux', arch: 'x64', exists: () => true }),
      '/repo/vendor/onlyoffice/linux-x64',
    );
  });
});

describe('bundled Office packaging', () => {
  it('selects the runtime matching the package target', () => {
    assert.equal(
      officeRuntimeSource('/repo', 'darwin', 'arm64'),
      '/repo/vendor/office-runtime/mac-arm64',
    );
    assert.equal(
      officeRuntimeSource('/repo', 'win32', 'x64'),
      '/repo/vendor/office-runtime/win-x64',
    );
  });

  it('fails packaging when the bundled editor is absent', () => {
    assert.throws(
      () => assertOfficeRuntime({
        projectRoot: '/repo',
        platform: 'linux',
        arch: 'x64',
        isExecutable: () => false,
      }),
      /prepare:office-runtime/i,
    );
  });

  it('prepares every supported installer and does not publish a partial Linux ARM64 build', async () => {
    const packageJson = require('../package.json');
    const builderConfig = require('../electron-builder.config.cjs');
    for (const name of ['pack:mac', 'pack:mac-x64', 'pack:mac-arm64', 'pack:win-x64', 'pack:win-arm64', 'pack:linux-x64']) {
      assert.match(packageJson.scripts[name], /prepare:office-runtime/);
      assert.match(packageJson.scripts[name], /verify:office-package/);
    }
    assert.match(packageJson.scripts['pack:mac'], /--x64/);
    assert.match(packageJson.scripts['pack:mac'], /--arm64/);
    assert.deepEqual(builderConfig.mac.target, ['dmg', 'zip']);
    assert.equal(packageJson.scripts['pack:linux-arm64'], undefined);

    const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    assert.doesNotMatch(releaseWorkflow, /linux-arm64/);
    assert.match(releaseWorkflow, /macos-15-intel/);
    assert.match(releaseWorkflow, /windows-11-arm/);
  });
});
