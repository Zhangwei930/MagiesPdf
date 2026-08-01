const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  bundledLibreOfficeExecutable,
  libreOfficeCandidates,
  libreOfficeLaunchArgs,
  officeRuntimeRoot,
  resolveLibreOfficeExecutable,
} = require('./libreOffice.cjs');

describe('bundledLibreOfficeExecutable', () => {
  it('uses the runtime copied into app resources on every supported platform', () => {
    assert.equal(
      bundledLibreOfficeExecutable('/app/resources/office-runtime', 'darwin'),
      '/app/resources/office-runtime/LibreOffice.app/Contents/MacOS/soffice',
    );
    assert.equal(
      bundledLibreOfficeExecutable('C:\\app\\resources\\office-runtime', 'win32'),
      'C:\\app\\resources\\office-runtime/program/soffice.exe',
    );
    assert.equal(
      bundledLibreOfficeExecutable('/app/resources/office-runtime', 'linux'),
      '/app/resources/office-runtime/program/soffice',
    );
  });
});

describe('officeRuntimeRoot', () => {
  it('uses app resources after packaging and the target-specific vendor folder in development', () => {
    assert.equal(
      officeRuntimeRoot({ packaged: true, resourcesPath: '/app/resources' }),
      '/app/resources/office-runtime',
    );
    assert.equal(
      officeRuntimeRoot({
        packaged: false,
        projectRoot: '/repo',
        platform: 'darwin',
        arch: 'arm64',
      }),
      '/repo/vendor/office-runtime/mac-arm64',
    );
  });
});

describe('libreOfficeCandidates', () => {
  it('uses the native application path on macOS', () => {
    assert.ok(
      libreOfficeCandidates('darwin', {}).includes(
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      ),
    );
  });

  it('does not invent a user Applications path when HOME is unavailable', () => {
    assert.deepEqual(libreOfficeCandidates('darwin', {}), [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    ]);
  });

  it('derives Windows candidates from Program Files', () => {
    assert.deepEqual(
      libreOfficeCandidates('win32', {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      }),
      [
        'C:\\Program Files/LibreOffice/program/soffice.exe',
        'C:\\Program Files (x86)/LibreOffice/program/soffice.exe',
      ],
    );
  });

  it('checks common Linux launcher paths', () => {
    assert.deepEqual(libreOfficeCandidates('linux', {}), [
      '/usr/bin/libreoffice',
      '/usr/bin/soffice',
      '/snap/bin/libreoffice',
    ]);
  });
});

describe('resolveLibreOfficeExecutable', () => {
  it('uses only the bundled runtime in a packaged app', () => {
    const executable = resolveLibreOfficeExecutable({
      bundledRoot: '/app/resources/office-runtime',
      configured: '/custom/soffice',
      packaged: true,
      platform: 'linux',
      env: {},
      isExecutable: (candidate) => candidate === '/custom/soffice',
    });

    assert.equal(executable, '');
  });

  it('prefers the bundled runtime during development when it is present', () => {
    const executable = resolveLibreOfficeExecutable({
      bundledRoot: '/repo/vendor/office-runtime/linux-x64',
      configured: '/custom/soffice',
      packaged: false,
      platform: 'linux',
      env: {},
      isExecutable: (candidate) => candidate === '/repo/vendor/office-runtime/linux-x64/program/soffice',
    });

    assert.equal(executable, '/repo/vendor/office-runtime/linux-x64/program/soffice');
  });

  it('prefers a configured executable and falls back to detected candidates', () => {
    const executable = resolveLibreOfficeExecutable({
      configured: '/custom/soffice',
      platform: 'linux',
      env: {},
      isExecutable: (candidate) => candidate === '/usr/bin/soffice',
    });

    assert.equal(executable, '/usr/bin/soffice');
  });

  it('returns the configured executable when it is runnable', () => {
    const executable = resolveLibreOfficeExecutable({
      configured: '/custom/soffice',
      platform: 'linux',
      env: {},
      isExecutable: (candidate) => candidate === '/custom/soffice',
    });

    assert.equal(executable, '/custom/soffice');
  });
});

describe('libreOfficeLaunchArgs', () => {
  it('opens supported documents without recovery or start-centre interruptions', () => {
    assert.deepEqual(libreOfficeLaunchArgs(['/docs/a.docx', '/docs/b.xlsx']), [
      '--nologo',
      '--nodefault',
      '--nofirststartwizard',
      '--norestore',
      '/docs/a.docx',
      '/docs/b.xlsx',
    ]);
  });

  it('rejects unsupported paths before starting another process', () => {
    assert.throws(() => libreOfficeLaunchArgs(['/docs/script.js']), /unsupported document/i);
  });
});
