import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { mergeMacUpdateManifests } from './mergeMacUpdateManifests.mjs';

const manifest = (arch, version = '3.0.2') => `version: ${version}
files:
  - url: MagiesPdf-${version}-mac-${arch}.zip
    sha512: ${arch}-zip-sha512
    size: ${arch === 'x64' ? 100 : 200}
  - url: MagiesPdf-${version}-mac-${arch}.dmg
    sha512: ${arch}-dmg-sha512
    size: ${arch === 'x64' ? 300 : 400}
path: MagiesPdf-${version}-mac-${arch}.zip
sha512: ${arch}-zip-sha512
releaseDate: '2026-08-15T10:00:00.000Z'
`;

describe('macOS update manifest merge', () => {
  /**
   * Electron 44 requires macOS 13, so a Monterey machine that installs this
   * build gets an app that cannot launch. `LSMinimumSystemVersion` in the
   * bundle stops a fresh install, but electron-updater never reads a plist —
   * it reads this manifest, and skips a release whose `minimumSystemVersion`
   * is above the running OS. Without the field the update ships anyway and
   * breaks the app it replaces.
   */
  it('carries the minimum OS version electron-updater checks before offering an update', () => {
    const merged = mergeMacUpdateManifests(manifest('x64'), manifest('arm64'), {
      minimumSystemVersion: '13.0',
    });

    assert.match(merged, /^minimumSystemVersion: 13\.0$/m);
  });

  it('omits the field when no minimum is given, rather than writing an empty one', () => {
    const merged = mergeMacUpdateManifests(manifest('x64'), manifest('arm64'));

    assert.doesNotMatch(merged, /minimumSystemVersion/);
  });

  it('keeps both architectures so electron-updater can select the native zip', () => {
    const merged = mergeMacUpdateManifests(manifest('x64'), manifest('arm64'));

    assert.match(merged, /url: MagiesPdf-3\.0\.2-mac-x64\.zip/);
    assert.match(merged, /url: MagiesPdf-3\.0\.2-mac-arm64\.zip/);
    assert.match(merged, /url: MagiesPdf-3\.0\.2-mac-x64\.dmg/);
    assert.match(merged, /url: MagiesPdf-3\.0\.2-mac-arm64\.dmg/);
    assert.match(merged, /^path: MagiesPdf-3\.0\.2-mac-x64\.zip$/m);
  });

  it('refuses to combine manifests from different versions', () => {
    assert.throws(
      () => mergeMacUpdateManifests(manifest('x64'), manifest('arm64', '3.0.3')),
      /same version/i,
    );
  });

  it('refuses a manifest that does not contain its expected architecture', () => {
    assert.throws(
      () => mergeMacUpdateManifests(manifest('arm64'), manifest('arm64')),
      /x64/i,
    );
  });

  it('is wired into the release workflow before publishing', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

    assert.match(workflow, /update-mac-\$\{\{ matrix\.arch \}\}\.yml/);
    assert.match(workflow, /mergeMacUpdateManifests\.mjs/);
    assert.match(workflow, /artifacts\/latest-mac\.yml/);
  });
});
