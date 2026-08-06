import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  PROVIDER_PRESETS,
  connectionState,
  createProviderFromPreset,
  groupProviders,
  isLoopbackEndpoint,
  presetFor,
} from './providers.ts';

describe('provider presets', () => {
  it('gives every preset a unique id, and a parsable base URL unless it is the custom one', () => {
    const ids = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
    assert.equal(ids.size, PROVIDER_PRESETS.length);
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === 'custom') {
        assert.equal(preset.baseUrl, '');
        continue;
      }
      assert.doesNotThrow(() => new URL(preset.baseUrl), preset.id);
    }
  });

  it('ships the vendors the settings pane offers, including NVIDIA NIM', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    for (const expected of ['deepseek', 'openai', 'nvidia', 'xai', 'ollama', 'custom']) {
      assert.ok(ids.includes(expected), `missing preset: ${expected}`);
    }
    assert.equal(presetFor('nvidia')?.baseUrl, 'https://integrate.api.nvidia.com/v1');
    assert.equal(presetFor('xai')?.baseUrl, 'https://api.x.ai/v1');
  });

  it('marks the local vendors as needing no API key', () => {
    assert.equal(presetFor('ollama')?.requiresApiKey, false);
    assert.equal(presetFor('deepseek')?.requiresApiKey, true);
  });

  it('resolves an unknown vendor id to nothing', () => {
    assert.equal(presetFor('nope'), null);
    assert.equal(presetFor(''), null);
  });
});

describe('createProviderFromPreset', () => {
  it('seeds a provider from the preset, defaulting to its first model', () => {
    const preset = presetFor('deepseek');
    assert.ok(preset);
    const provider = createProviderFromPreset(preset, () => 'id-1');

    assert.deepEqual(provider, {
      id: 'id-1',
      providerId: 'deepseek',
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.models[0],
      enabled: true,
    });
  });

  it('leaves the model empty when the vendor suggests none', () => {
    const preset = presetFor('custom');
    assert.ok(preset);
    assert.equal(createProviderFromPreset(preset, () => 'id-2').model, '');
  });
});

describe('groupProviders', () => {
  const provider = (id: string, baseUrl: string) => ({
    id, providerId: 'custom', name: id, baseUrl, model: 'm', enabled: true,
  });

  it('splits on where the endpoint actually points, not on the vendor name', () => {
    const { local, remote } = groupProviders([
      provider('a', 'https://api.deepseek.com/v1'),
      provider('b', 'http://127.0.0.1:11434/v1'),
      provider('c', 'http://localhost:1234/v1'),
    ]);

    assert.deepEqual(local.map((entry) => entry.id), ['b', 'c']);
    assert.deepEqual(remote.map((entry) => entry.id), ['a']);
  });

  it('keeps the given order within each group', () => {
    const { remote } = groupProviders([
      provider('first', 'https://one.example.com/v1'),
      provider('second', 'https://two.example.com/v1'),
    ]);
    assert.deepEqual(remote.map((entry) => entry.id), ['first', 'second']);
  });

  it('treats an unparsable endpoint as remote rather than hiding it', () => {
    const { local, remote } = groupProviders([provider('x', 'not a url')]);
    assert.equal(local.length, 0);
    assert.deepEqual(remote.map((entry) => entry.id), ['x']);
  });
});

describe('isLoopbackEndpoint', () => {
  it('recognises the local addresses that need no API key', () => {
    assert.equal(isLoopbackEndpoint('http://127.0.0.1:11434/v1'), true);
    assert.equal(isLoopbackEndpoint('http://localhost:1234/v1'), true);
    assert.equal(isLoopbackEndpoint('http://[::1]:11434/v1'), true);
  });

  it('treats remote and unparsable endpoints as non-local', () => {
    assert.equal(isLoopbackEndpoint('https://api.deepseek.com/v1'), false);
    assert.equal(isLoopbackEndpoint('not a url'), false);
  });
});

describe('connectionState', () => {
  const base = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyConfigured: true };

  it('reports an empty configuration', () => {
    assert.equal(connectionState({ ...base, baseUrl: '  ', model: '' }), 'unconfigured');
  });

  it('reports an invalid base URL before anything else', () => {
    assert.equal(connectionState({ ...base, baseUrl: 'api.deepseek.com' }), 'invalidUrl');
  });

  it('reports a missing model', () => {
    assert.equal(connectionState({ ...base, model: '   ' }), 'needsModel');
  });

  it('requires a key for a remote endpoint only', () => {
    assert.equal(connectionState({ ...base, apiKeyConfigured: false }), 'needsKey');
    assert.equal(
      connectionState({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', apiKeyConfigured: false }),
      'ready',
    );
  });

  it('reports a complete remote configuration as ready', () => {
    assert.equal(connectionState(base), 'ready');
  });

  it('reports nothing selected when there is no provider at all', () => {
    assert.equal(connectionState(null), 'noProvider');
  });
});
