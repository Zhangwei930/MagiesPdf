import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LIBREOFFICE_VERSION,
  officeRuntimeDirectory,
  officeRuntimeExecutable,
  officeRuntimeNotice,
  officeRuntimeSpec,
} from './officeRuntime.mjs';

describe('officeRuntimeSpec', () => {
  it('pins official LibreOffice downloads for macOS and Windows architectures', () => {
    const specs = [
      officeRuntimeSpec('darwin', 'x64'),
      officeRuntimeSpec('darwin', 'arm64'),
      officeRuntimeSpec('win32', 'x64'),
      officeRuntimeSpec('win32', 'arm64'),
    ];
    assert.match(specs[0].url, /MacOS_x86-64\.dmg$/);
    assert.match(specs[1].url, /MacOS_aarch64\.dmg$/);
    assert.match(specs[2].url, /Win_x86-64\.msi$/);
    assert.match(specs[3].url, /Win_aarch64\.msi$/);
    for (const spec of specs) {
      assert.match(spec.sha256, /^[a-f0-9]{64}$/);
      assert.equal(spec.mirrors.length, 2);
    }
  });

  it('supports the official Linux x64 bundle and rejects an incomplete ARM64 release', () => {
    const linux = officeRuntimeSpec('linux', 'x64');
    assert.match(linux.url, /Linux_x86-64_deb\.tar\.gz$/);
    assert.match(linux.sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => officeRuntimeSpec('linux', 'arm64'), /not published/i);
  });

  it('uses one normalized runtime layout for packaging', () => {
    assert.equal(officeRuntimeDirectory('darwin', 'arm64'), 'mac-arm64');
    assert.equal(
      officeRuntimeExecutable('/repo/vendor/office-runtime/mac-arm64', 'darwin'),
      '/repo/vendor/office-runtime/mac-arm64/LibreOffice.app/Contents/MacOS/soffice',
    );
    assert.equal(
      officeRuntimeExecutable('/repo/vendor/office-runtime/linux-x64', 'linux'),
      '/repo/vendor/office-runtime/linux-x64/program/soffice',
    );
  });

  it('preserves the upstream download, licence and source notices', () => {
    const spec = officeRuntimeSpec('linux', 'x64');
    const notice = officeRuntimeNotice(spec);

    assert.match(notice, new RegExp(`LibreOffice ${LIBREOFFICE_VERSION}`));
    assert.match(notice, new RegExp(spec.url.replaceAll('.', '\\.')));
    assert.match(notice, /MPL-2\.0/i);
    assert.match(notice, new RegExp(`/libreoffice/src/${LIBREOFFICE_VERSION}/`));
  });
});
