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
