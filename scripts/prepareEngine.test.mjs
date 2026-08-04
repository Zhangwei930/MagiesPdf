import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { engineAsset, targetDirectory } from './prepareEngine.mjs';

/**
 * Which download holds the converter for a target, and where inside it.
 *
 * Only the converter differs between platforms — everything else the engine
 * needs is javascript, kept once. So preparing a target is: fetch that
 * platform's desktop package, take one directory out of it, and leave the rest.
 *
 * The paths are what the packages actually contain, read from each of them.
 * Guessing one wrong produces a target directory that looks prepared and has
 * no converter in it.
 */

describe('the download a target’s converter comes from', () => {
  it('knows each platform’s package and where the converter sits in it', () => {
    assert.deepEqual(engineAsset({ platform: 'darwin', arch: 'arm64' }), {
      name: 'ONLYOFFICE-arm.dmg',
      kind: 'dmg',
      converter: 'ONLYOFFICE.app/Contents/Resources/converter',
    });
    assert.deepEqual(engineAsset({ platform: 'darwin', arch: 'x64' }), {
      name: 'ONLYOFFICE-x86_64.dmg',
      kind: 'dmg',
      converter: 'ONLYOFFICE.app/Contents/Resources/converter',
    });
    assert.deepEqual(engineAsset({ platform: 'win32', arch: 'x64' }), {
      name: 'DesktopEditors_x64.zip',
      kind: 'zip',
      converter: 'converter',
    });
    assert.deepEqual(engineAsset({ platform: 'win32', arch: 'arm64' }), {
      name: 'DesktopEditors_arm64.zip',
      kind: 'zip',
      converter: 'converter',
    });
    assert.deepEqual(engineAsset({ platform: 'linux', arch: 'x64' }), {
      name: 'onlyoffice-desktopeditors_amd64.deb',
      kind: 'deb',
      converter: 'opt/onlyoffice/desktopeditors/converter',
    });
    assert.deepEqual(engineAsset({ platform: 'linux', arch: 'arm64' }), {
      name: 'onlyoffice-desktopeditors_arm64.deb',
      kind: 'deb',
      converter: 'opt/onlyoffice/desktopeditors/converter',
    });
  });

  /** Better to refuse than to prepare a directory with the wrong binary in it. */
  it('refuses a target it has no package for', () => {
    assert.throws(() => engineAsset({ platform: 'win32', arch: 'ia32' }), /win32-ia32/);
    assert.throws(() => engineAsset({ platform: 'sunos', arch: 'x64' }), /sunos/);
  });

  it('puts each target where the build looks for it', () => {
    assert.equal(
      targetDirectory('/repo', { platform: 'win32', arch: 'arm64' }),
      '/repo/vendor/onlyoffice/win-arm64',
    );
    assert.equal(
      targetDirectory('/repo', { platform: 'darwin', arch: 'x64' }),
      '/repo/vendor/onlyoffice/mac-x64',
    );
  });
});
