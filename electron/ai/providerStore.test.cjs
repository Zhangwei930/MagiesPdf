'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProviders,
  resolveActiveProvider,
  secretKeyForProvider,
  LEGACY_PROVIDER_ID,
} = require('./providerStore.cjs');

test('normalizeProviders keeps a well-formed list and its active selection', () => {
  const state = normalizeProviders({
    providers: [
      { id: 'a', providerId: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', enabled: true },
      { id: 'b', providerId: 'custom', name: 'Home', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', enabled: true },
    ],
    activeProviderId: 'b',
  });

  assert.equal(state.providers.length, 2);
  assert.equal(state.activeProviderId, 'b');
});

test('a provider carries its own reasoning effort, and only a level it could accept', () => {
  const state = normalizeProviders({
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://x/v1', model: 'm', reasoningEffort: 'high' },
      { id: 'b', name: 'B', baseUrl: 'https://y/v1', model: 'm', reasoningEffort: 'turbo' },
    ],
  });

  assert.equal(state.providers[0].reasoningEffort, 'high');
  // Anything else is dropped: an unknown level makes the provider reject the
  // whole request rather than ignore the field.
  assert.equal(state.providers[1].reasoningEffort, '');
});

test('normalizeProviders drops entries without an id or a base URL', () => {
  const state = normalizeProviders({
    providers: [
      { id: '', name: 'no id', baseUrl: 'https://example.com/v1' },
      { id: 'b', name: 'no url', baseUrl: '   ' },
      { id: 'c', name: 'fine', baseUrl: 'https://example.com/v1', model: 'm' },
    ],
    activeProviderId: 'c',
  });

  assert.deepEqual(state.providers.map((provider) => provider.id), ['c']);
});

test('normalizeProviders de-duplicates ids, keeping the first', () => {
  const state = normalizeProviders({
    providers: [
      { id: 'dup', name: 'first', baseUrl: 'https://example.com/v1', model: 'a' },
      { id: 'dup', name: 'second', baseUrl: 'https://example.com/v2', model: 'b' },
    ],
  });

  assert.equal(state.providers.length, 1);
  assert.equal(state.providers[0].name, 'first');
});

test('normalizeProviders falls back to the first enabled provider when the active id is stale', () => {
  const state = normalizeProviders({
    providers: [
      { id: 'a', name: 'off', baseUrl: 'https://example.com/v1', model: 'm', enabled: false },
      { id: 'b', name: 'on', baseUrl: 'https://example.com/v2', model: 'm', enabled: true },
    ],
    activeProviderId: 'gone',
  });

  assert.equal(state.activeProviderId, 'b');
});

test('normalizeProviders migrates a legacy single configuration into one provider', () => {
  const state = normalizeProviders({
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    maxSteps: 8,
  });

  assert.equal(state.providers.length, 1);
  assert.equal(state.providers[0].id, LEGACY_PROVIDER_ID);
  assert.equal(state.providers[0].baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(state.providers[0].model, 'deepseek-chat');
  assert.equal(state.activeProviderId, LEGACY_PROVIDER_ID);
});

test('an explicitly empty list is not refilled from the pre-list fields', () => {
  // Deleting every provider leaves `providers: []` behind. Resurrecting the
  // old baseUrl/model there brings back a vendor the user removed.
  const state = normalizeProviders({
    providers: [],
    activeProviderId: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  });

  assert.deepEqual(state, { providers: [], activeProviderId: '' });
});

test('normalizeProviders does not invent a provider from an empty legacy configuration', () => {
  assert.deepEqual(normalizeProviders({ baseUrl: '', model: '' }), {
    providers: [],
    activeProviderId: '',
  });
  assert.deepEqual(normalizeProviders(undefined), { providers: [], activeProviderId: '' });
});

test('normalizeProviders ignores the legacy fields once a list exists', () => {
  const state = normalizeProviders({
    baseUrl: 'https://legacy.example.com/v1',
    model: 'legacy',
    providers: [{ id: 'a', name: 'New', baseUrl: 'https://example.com/v1', model: 'm' }],
    activeProviderId: 'a',
  });

  assert.deepEqual(state.providers.map((provider) => provider.id), ['a']);
});

test('resolveActiveProvider returns the selected provider only when it is usable', () => {
  const ai = {
    providers: [
      { id: 'a', name: 'A', baseUrl: 'https://example.com/v1', model: 'm', enabled: true },
      { id: 'b', name: 'B', baseUrl: 'https://example.com/v2', model: '', enabled: true },
    ],
    activeProviderId: 'a',
  };

  assert.equal(resolveActiveProvider(ai).id, 'a');
  assert.equal(resolveActiveProvider({ ...ai, activeProviderId: 'b' }).id, 'b');
  assert.equal(resolveActiveProvider({ providers: [], activeProviderId: '' }), null);
});

test('the migrated provider keeps reading the key stored before provider ids existed', () => {
  assert.equal(secretKeyForProvider(LEGACY_PROVIDER_ID), 'apiKey');
  assert.equal(secretKeyForProvider('abc'), 'apiKey:abc');
  assert.equal(secretKeyForProvider(''), '');
});
