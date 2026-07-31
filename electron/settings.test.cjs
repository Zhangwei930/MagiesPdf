const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { DEFAULTS, merge } = require('./settings.cjs');

describe('Office settings', () => {
  it('keeps local and collaborative editors disabled until configured', () => {
    assert.deepEqual(DEFAULTS.office, {
      libreOfficeExecutable: '',
      collaboraUrl: '',
      wopiPublicUrl: '',
    });
  });

  it('deep-merges one Office setting without dropping the others', () => {
    const next = merge(DEFAULTS, { office: { collaboraUrl: 'https://office.example.com' } });

    assert.deepEqual(next.office, {
      libreOfficeExecutable: '',
      collaboraUrl: 'https://office.example.com',
      wopiPublicUrl: '',
    });
  });
});
