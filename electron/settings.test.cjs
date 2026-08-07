const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { DEFAULTS, merge, preserveLegacyUserDataPath } = require('./settings.cjs');
const { sanitizeProviderList } = require('./ai/providerStore.cjs');

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

  it('remembers that the welcome tour was dismissed for good', () => {
    // The whitelist drops keys the defaults do not name, so a flag missing from
    // DEFAULTS is written and silently lost — and the tour returns every launch.
    assert.equal(DEFAULTS.onboardingComplete, false);
    assert.equal(merge(DEFAULTS, { onboardingComplete: true }).onboardingComplete, true);
  });

  it('starts with an empty local recent-document list', () => {
    assert.deepEqual(DEFAULTS.recentDocuments, []);
  });

  it('starts on DeepSeek, so a fresh install only has to paste a key', () => {
    assert.deepEqual(DEFAULTS.ai.providers, [{
      id: 'deepseek',
      providerId: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      enabled: true,
    }]);
    assert.equal(DEFAULTS.ai.activeProviderId, 'deepseek');
    assert.equal(JSON.stringify(DEFAULTS.ai).includes('apiKey'), false);
  });

  it('lets a user who removed every provider stay at none', () => {
    // Arrays are replaced, not merged, so an empty stored list wins over the
    // seeded one; otherwise DeepSeek would reappear after every deletion.
    assert.deepEqual(merge(DEFAULTS, { ai: { providers: [], activeProviderId: '' } }).ai.providers, []);
  });

  it('keeps the pre-list fields so an older settings file still merges', () => {
    assert.deepEqual({
      baseUrl: DEFAULTS.ai.baseUrl,
      model: DEFAULTS.ai.model,
      maxSteps: DEFAULTS.ai.maxSteps,
    }, {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: '',
      maxSteps: 6,
    });
  });

  it('deep-merges AI provider settings without accepting unknown secret fields', () => {
    const next = merge(DEFAULTS, {
      ai: {
        providers: [{ id: 'a', providerId: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', enabled: true }],
        activeProviderId: 'a',
        apiKey: 'must-not-persist',
      },
    });

    assert.deepEqual(next.ai.providers, [{
      id: 'a',
      providerId: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      enabled: true,
    }]);
    assert.equal(next.ai.activeProviderId, 'a');
    assert.equal('apiKey' in next.ai, false);
  });

  it('keeps the keys of an open dictionary, which the whitelist would drop', () => {
    // `merge` only keeps keys the defaults already name. A map keyed by
    // something dynamic — an agent id — has none, so recursing into it threw
    // every entry away and the user's choice never persisted.
    const next = merge(DEFAULTS, {
      ai: { cliModels: { antigravity: { model: 'gemini-3.6-flash-high', effort: 'high' } } },
    });

    assert.deepEqual(next.ai.cliModels, {
      antigravity: { model: 'gemini-3.6-flash-high', effort: 'high' },
    });
  });

  it('still merges a nested object whose shape the defaults do describe', () => {
    const next = merge(DEFAULTS, { api: { port: 9000 } });
    assert.equal(next.api.port, 9000);
    // The keys not mentioned survive rather than being replaced away.
    assert.equal(next.api.enabled, DEFAULTS.api.enabled);
  });

  it('never persists an API key smuggled onto a provider entry', () => {
    // `merge` replaces arrays wholesale, so the IPC boundary is what strips
    // unknown fields; this asserts the two together.
    const patch = {
      ai: {
        providers: sanitizeProviderList([
          { id: 'a', name: 'A', baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'must-not-persist' },
        ]),
      },
    };
    const next = merge(DEFAULTS, patch);

    assert.equal(JSON.stringify(next.ai).includes('must-not-persist'), false);
    assert.equal('apiKey' in next.ai.providers[0], false);
  });
});
