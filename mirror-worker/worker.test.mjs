/* global Request */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildManifest, resolveAssetName } from './src/worker.js';

test('manifest is synthesized from the GitHub API release payload', () => {
  const manifest = buildManifest(
    {
      tag_name: 'v1.0.0',
      published_at: '2026-07-27T12:00:00Z',
      assets: [
        { name: 'MagiesPdf-1.0.0-mac-x64.dmg', size: 111 },
        { name: 'latest.yml', size: 22 },
      ],
    },
    'https://dl.magies.top',
  );

  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.tag, 'v1.0.0');
  assert.equal(manifest.publishedAt, '2026-07-27T12:00:00Z');
  assert.deepEqual(manifest.files[0], {
    name: 'MagiesPdf-1.0.0-mac-x64.dmg',
    size: 111,
    url: 'https://dl.magies.top/magiespdf/stable/MagiesPdf-1.0.0-mac-x64.dmg',
  });
  assert.equal(manifest.files[1].url, 'https://dl.magies.top/magiespdf/stable/latest.yml');
});

test('asset names resolve only under /magiespdf/stable/ and never the manifest itself', () => {
  assert.equal(resolveAssetName('/magiespdf/stable/latest.yml'), 'latest.yml');
  assert.equal(
    resolveAssetName('/magiespdf/stable/MagiesPdf-1.0.0-win-x64.exe'),
    'MagiesPdf-1.0.0-win-x64.exe',
  );
  assert.equal(resolveAssetName('/magiespdf/stable/release.json'), null);
  assert.equal(resolveAssetName('/magiespdf/stable/'), null);
  assert.equal(resolveAssetName('/magiespdf/stable/a/b'), null);
  // MagiesTerminal path must not resolve here
  assert.equal(resolveAssetName('/stable/latest.yml'), null);
  assert.equal(resolveAssetName('/other/latest.yml'), null);
});

test('encoded asset names are decoded', () => {
  assert.equal(resolveAssetName('/magiespdf/stable/some%20file.zip'), 'some file.zip');
});

test('unknown paths answer 404', async () => {
  const worker = (await import('./src/worker.js')).default;
  const response = await worker.fetch(new Request('https://dl.magies.top/stable/latest.yml'));
  assert.equal(response.status, 404);
});
