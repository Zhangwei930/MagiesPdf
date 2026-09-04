const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { executableProblem } = require('./executable.cjs');

const file = (mode) => ({ isFile: () => true, mode });
const directory = { isFile: () => false, mode: 0o755 };

describe('choosing an external converter', () => {
  it('accepts a file with an execute bit on unix', () => {
    assert.equal(executableProblem({ stat: file(0o755), path: '/usr/bin/soffice', platform: 'linux' }), null);
    assert.equal(executableProblem({ stat: file(0o500), path: '/usr/bin/soffice', platform: 'darwin' }), null);
  });

  it('refuses a file with no execute bit on unix', () => {
    assert.equal(
      executableProblem({ stat: file(0o644), path: '/docs/notes.txt', platform: 'linux' }),
      'not-executable',
    );
  });

  /**
   * Windows has no execute bit — every file would pass a mode check, so the
   * extension is what says whether it can be run.
   */
  it('goes by extension on Windows', () => {
    assert.equal(
      executableProblem({ stat: file(0o644), path: 'C:\\\\Office\\\\soffice.exe', platform: 'win32' }),
      null,
    );
    assert.equal(
      executableProblem({ stat: file(0o644), path: 'C:\\\\Office\\\\run.BAT', platform: 'win32' }),
      null,
    );
    assert.equal(
      executableProblem({ stat: file(0o644), path: 'C:\\\\Office\\\\readme.txt', platform: 'win32' }),
      'not-executable',
    );
  });

  it('refuses a directory, including a macOS app bundle', () => {
    assert.equal(
      executableProblem({ stat: directory, path: '/Applications/LibreOffice.app', platform: 'darwin' }),
      'not-a-file',
    );
  });

  it('says nothing can be checked when the path does not exist', () => {
    assert.equal(executableProblem({ stat: null, path: '/nope', platform: 'linux' }), 'missing');
  });
});
