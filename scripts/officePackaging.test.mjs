import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  assertOfficeRuntime,
  officeRuntimeSource,
} = require('./officePackaging.cjs');

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
