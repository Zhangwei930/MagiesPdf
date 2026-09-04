import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const RELEASE_VERSION = '3.2.0';

describe('v3.2.0 release metadata', () => {
  it('keeps package metadata and release notes on the published version', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const changelogs = await Promise.all([
      readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
      readFile(new URL('../src/app/changelog/en.md', import.meta.url), 'utf8'),
      readFile(new URL('../src/app/changelog/zh.md', import.meta.url), 'utf8'),
    ]);

    assert.equal(packageJson.version, RELEASE_VERSION);
    assert.equal(packageLock.version, RELEASE_VERSION);
    assert.equal(packageLock.packages[''].version, RELEASE_VERSION);
    for (const changelog of changelogs) {
      assert.match(changelog, new RegExp(`^## ${RELEASE_VERSION} — `, 'm'));
    }
  });
});
