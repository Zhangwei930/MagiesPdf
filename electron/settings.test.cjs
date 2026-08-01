const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { DEFAULTS, merge, preserveLegacyUserDataPath } = require('./settings.cjs');

describe('Office settings', () => {
  it('keeps existing user data after the product name changes', () => {
    const calls = [];
    const electronApp = {
      getPath: (name) => {
        assert.equal(name, 'appData');
        return '/Users/example/Library/Application Support';
      },
      setPath: (name, value) => calls.push([name, value]),
    };

    preserveLegacyUserDataPath(electronApp);

    assert.deepEqual(calls, [[
      'userData',
      '/Users/example/Library/Application Support/MagiesPdf',
    ]]);
  });

  it('stores only the optional local editor path', () => {
    assert.deepEqual(DEFAULTS.office, {
      libreOfficeExecutable: '',
    });
  });

  it('deep-merges the local Office setting', () => {
    const next = merge(DEFAULTS, { office: { libreOfficeExecutable: '/opt/soffice' } });

    assert.deepEqual(next.office, {
      libreOfficeExecutable: '/opt/soffice',
    });
  });

  it('starts with an empty local recent-document list', () => {
    assert.deepEqual(DEFAULTS.recentDocuments, []);
  });
});
