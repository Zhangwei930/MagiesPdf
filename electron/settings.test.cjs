const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { DEFAULTS, merge } = require('./settings.cjs');

describe('Office settings', () => {
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
