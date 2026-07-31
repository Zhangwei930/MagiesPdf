const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  libreOfficeCandidates,
  libreOfficeLaunchArgs,
  resolveLibreOfficeExecutable,
} = require('./libreOffice.cjs');

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
