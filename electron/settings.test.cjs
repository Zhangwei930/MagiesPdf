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

  it('provides a local-first OpenAI-compatible assistant configuration', () => {
    assert.deepEqual(DEFAULTS.ai, {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: '',
      maxSteps: 6,
    });
    assert.equal(JSON.stringify(DEFAULTS.ai).includes('apiKey'), false);
  });

  it('deep-merges AI provider settings without accepting unknown secret fields', () => {
    const next = merge(DEFAULTS, {
      ai: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'must-not-persist',
      },
    });

    assert.deepEqual(next.ai, {
      baseUrl: 'https://api.example.com/v1',
      model: '',
      maxSteps: 6,
    });
  });
});
