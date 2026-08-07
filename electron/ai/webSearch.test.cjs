'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WEB_SEARCH_PRESETS,
  createWebSearchProvider,
  searchRequestFor,
  normalizeResults,
} = require('./webSearch.cjs');

test('every preset names an endpoint and says whether it needs a key', () => {
  assert.ok(WEB_SEARCH_PRESETS.length >= 4);
  for (const preset of WEB_SEARCH_PRESETS) {
    assert.ok(preset.id, 'id');
    assert.ok(preset.name, `${preset.id}: name`);
    assert.equal(typeof preset.requiresApiKey, 'boolean', `${preset.id}: requiresApiKey`);
    if (preset.id !== 'searxng') assert.doesNotThrow(() => new URL(preset.endpoint), preset.id);
  }
});

test('searchRequestFor builds the Tavily call with the key in the body, not the URL', () => {
  const request = searchRequestFor('tavily', { endpoint: '', query: 'pdf tools', apiKey: 'k', limit: 3 });

  assert.equal(request.url, 'https://api.tavily.com/search');
  assert.equal(request.init.method, 'POST');
  assert.doesNotMatch(request.url, /k/);
  assert.deepEqual(JSON.parse(request.init.body), {
    api_key: 'k',
    query: 'pdf tools',
    max_results: 3,
  });
});

test('searchRequestFor sends the key as a header where the vendor expects one', () => {
  const bocha = searchRequestFor('bocha', { endpoint: '', query: 'q', apiKey: 'k', limit: 5 });
  assert.equal(bocha.init.headers.Authorization, 'Bearer k');

  const exa = searchRequestFor('exa', { endpoint: '', query: 'q', apiKey: 'k', limit: 5 });
  assert.equal(exa.init.headers['x-api-key'], 'k');
});

test('searchRequestFor points SearXNG at the user own instance', () => {
  const request = searchRequestFor('searxng', {
    endpoint: 'http://127.0.0.1:8080',
    query: 'a b',
    apiKey: '',
    limit: 5,
  });

  assert.match(request.url, /^http:\/\/127\.0\.0\.1:8080\/search\?/);
  assert.match(request.url, /q=a\+b|q=a%20b/);
  assert.match(request.url, /format=json/);
  assert.equal(request.init.method, 'GET');
});

test('searchRequestFor rejects an unknown provider', () => {
  assert.throws(() => searchRequestFor('nope', { query: 'q' }), /unknown/i);
});

test('normalizeResults reads each vendor own response shape', () => {
  assert.deepEqual(
    normalizeResults('tavily', { results: [{ title: 'T', url: 'https://a', content: 'C' }] }),
    [{ title: 'T', url: 'https://a', snippet: 'C' }],
  );
  assert.deepEqual(
    normalizeResults('exa', { results: [{ title: 'T', url: 'https://a', text: 'C' }] }),
    [{ title: 'T', url: 'https://a', snippet: 'C' }],
  );
  assert.deepEqual(
    normalizeResults('searxng', { results: [{ title: 'T', url: 'https://a', content: 'C' }] }),
    [{ title: 'T', url: 'https://a', snippet: 'C' }],
  );
  assert.deepEqual(
    normalizeResults('bocha', { data: { webPages: { value: [{ name: 'T', url: 'https://a', snippet: 'C' }] } } }),
    [{ title: 'T', url: 'https://a', snippet: 'C' }],
  );
});

test('normalizeResults survives a response that is not shaped as documented', () => {
  assert.deepEqual(normalizeResults('tavily', {}), []);
  assert.deepEqual(normalizeResults('tavily', null), []);
  assert.deepEqual(normalizeResults('bocha', { data: {} }), []);
});

function providerWith(overrides = {}) {
  return createWebSearchProvider({
    readConfig: () => ({
      enabled: true,
      provider: 'tavily',
      endpoint: '',
      strictLocalPrivacy: false,
      apiKey: 'k',
    }),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ title: 'T', url: 'https://a', content: 'C' }] }),
    }),
    ...overrides,
  });
}

test('the tool is offered only when search is configured', async () => {
  assert.equal((await providerWith().listTools()).length, 1);

  const off = providerWith({ readConfig: () => ({ enabled: false, provider: 'tavily', apiKey: 'k' }) });
  assert.deepEqual(await off.listTools(), []);

  const noKey = providerWith({ readConfig: () => ({ enabled: true, provider: 'tavily', apiKey: '' }) });
  assert.deepEqual(await noKey.listTools(), []);
});

test('strict local privacy withdraws the tool entirely', async () => {
  // Not merely refused on call: the model must not be told it exists, or it
  // will keep trying and narrating failures.
  const provider = providerWith({
    readConfig: () => ({ enabled: true, provider: 'tavily', apiKey: 'k', strictLocalPrivacy: true }),
  });
  assert.deepEqual(await provider.listTools(), []);
});

test('the tool describes itself as reaching the internet', async () => {
  const [tool] = await providerWith().listTools();
  assert.equal(tool.functionName, 'web_search');
  assert.equal(tool.requiresApproval, true);
  assert.match(tool.providerTool.function.description, /internet|web/i);
});

test('callTool returns normalized results', async () => {
  const result = await providerWith().callTool('web_search', { query: 'pdf' });
  assert.deepEqual(result.results, [{ title: 'T', url: 'https://a', snippet: 'C' }]);
});

test('callTool refuses an empty query rather than searching for nothing', async () => {
  await assert.rejects(() => providerWith().callTool('web_search', { query: '  ' }), /query/i);
});

test('callTool reports an HTTP failure with its status', async () => {
  const provider = providerWith({
    fetch: async () => ({ ok: false, status: 401, text: async () => 'bad key' }),
  });
  await assert.rejects(() => provider.callTool('web_search', { query: 'q' }), /401/);
});

test('callTool refuses while strict local privacy is on, even if called directly', async () => {
  const provider = providerWith({
    readConfig: () => ({ enabled: true, provider: 'tavily', apiKey: 'k', strictLocalPrivacy: true }),
  });
  await assert.rejects(() => provider.callTool('web_search', { query: 'q' }), /privacy/i);
});

test('callTool rejects a function name that is not ours', async () => {
  await assert.rejects(() => providerWith().callTool('something_else', { query: 'q' }), /unknown/i);
});
