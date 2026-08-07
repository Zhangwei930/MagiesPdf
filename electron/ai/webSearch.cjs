'use strict';

/**
 * Web search, offered to the Agent as one tool.
 *
 * This is the only tool in the app that reaches the public internet, so three
 * things are deliberate:
 *
 * - **The key never travels in a URL.** Query strings end up in proxy logs and
 *   in history; every vendor here takes the key in a body or a header.
 * - **Strict local privacy withdraws the tool from the list**, rather than
 *   refusing it when called. A model told about a tool that always fails will
 *   keep calling it and narrating the failure. It is refused on call as well,
 *   because `listTools` and `callTool` can be reached independently.
 * - **It requires approval like any other tool that leaves the machine**, so
 *   the user sees the query before it is sent.
 */

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const SNIPPET_LIMIT = 600;

const WEB_SEARCH_PRESETS = Object.freeze([
  {
    id: 'tavily',
    name: 'Tavily',
    endpoint: 'https://api.tavily.com/search',
    requiresApiKey: true,
    hint: { zh: '为模型检索设计，返回摘要', en: 'Built for model retrieval, returns summaries' },
  },
  {
    id: 'bocha',
    name: '博查 Bocha',
    endpoint: 'https://api.bochaai.com/v1/web-search',
    requiresApiKey: true,
    hint: { zh: '国内可直连', en: 'Reachable from mainland China' },
  },
  {
    id: 'exa',
    name: 'Exa',
    endpoint: 'https://api.exa.ai/search',
    requiresApiKey: true,
    hint: { zh: '语义检索', en: 'Semantic search' },
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    endpoint: '',
    requiresApiKey: false,
    hint: { zh: '自建实例，填你自己的地址', en: 'Self-hosted; give your own address' },
  },
]);

function presetFor(providerId) {
  return WEB_SEARCH_PRESETS.find((preset) => preset.id === providerId) ?? null;
}

/** The HTTP call for one vendor. Pure, so each vendor's shape is testable. */
function searchRequestFor(providerId, { endpoint = '', query, apiKey = '', limit = DEFAULT_LIMIT }) {
  const preset = presetFor(providerId);
  if (!preset) throw new Error(`Unknown web search provider: ${providerId}`);

  const size = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
  const base = String(endpoint || '').trim() || preset.endpoint;
  const json = { 'Content-Type': 'application/json' };

  switch (providerId) {
    case 'tavily':
      return {
        url: base,
        init: {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ api_key: apiKey, query, max_results: size }),
        },
      };
    case 'bocha':
      return {
        url: base,
        init: {
          method: 'POST',
          headers: { ...json, Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, count: size }),
        },
      };
    case 'exa':
      return {
        url: base,
        init: {
          method: 'POST',
          headers: { ...json, 'x-api-key': apiKey },
          body: JSON.stringify({ query, numResults: size, contents: { text: true } }),
        },
      };
    case 'searxng': {
      const url = new URL('/search', base.replace(/\/+$/, ''));
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      return { url: url.toString(), init: { method: 'GET', headers: { Accept: 'application/json' } } };
    }
    default:
      throw new Error(`Unknown web search provider: ${providerId}`);
  }
}

function trim(value) {
  const text = String(value ?? '').trim();
  return text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}…` : text;
}

/** Flattens each vendor's response into the one shape the model is shown. */
function normalizeResults(providerId, payload) {
  if (!payload || typeof payload !== 'object') return [];

  const rows = providerId === 'bocha'
    ? payload.data?.webPages?.value
    : payload.results;
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => ({
      title: trim(row?.title ?? row?.name),
      url: String(row?.url ?? ''),
      snippet: trim(row?.content ?? row?.snippet ?? row?.text ?? row?.description),
    }))
    .filter((row) => row.url);
}

const SEARCH_TOOL = Object.freeze({
  functionName: 'web_search',
  toolId: 'web:search',
  name: { zh: '联网搜索', en: 'Web search' },
  requiresApproval: true,
  // Never runs without a person present: it is the one tool that leaves the
  // machine, so an unattended automation may not reach for it.
  unattended: false,
  providerTool: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public internet and return titles, URLs and short snippets. '
        + 'The query leaves this machine, so use it only when the answer cannot come from the '
        + 'open documents or the local workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LIMIT,
            description: `How many results to return. Defaults to ${DEFAULT_LIMIT}.`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
});

function createWebSearchProvider({ readConfig, fetch: fetchImpl = globalThis.fetch } = {}) {
  const usable = (config) => {
    if (!config?.enabled) return false;
    if (config.strictLocalPrivacy) return false;
    const preset = presetFor(config.provider);
    if (!preset) return false;
    if (preset.requiresApiKey && !config.apiKey) return false;
    if (preset.id === 'searxng' && !String(config.endpoint || '').trim()) return false;
    return true;
  };

  return {
    async listTools() {
      return usable(readConfig()) ? [{ ...SEARCH_TOOL }] : [];
    },

    async callTool(functionName, args = {}, { signal } = {}) {
      if (functionName !== SEARCH_TOOL.functionName) {
        throw new Error(`Unknown web search tool: ${functionName}`);
      }

      const config = readConfig();
      if (config?.strictLocalPrivacy) {
        throw new Error('Strict local privacy is on, so web search is not available');
      }
      if (!usable(config)) throw new Error('Web search is not configured');

      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('A non-empty query is required');

      const { url, init } = searchRequestFor(config.provider, {
        endpoint: config.endpoint,
        query,
        apiKey: config.apiKey,
        limit: args.limit,
      });

      const response = await fetchImpl(url, { ...init, signal });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Web search failed with HTTP ${response.status}${body ? `: ${trim(body)}` : ''}`);
      }

      const payload = await response.json();
      return { query, results: normalizeResults(config.provider, payload) };
    },
  };
}

module.exports = {
  WEB_SEARCH_PRESETS,
  SEARCH_TOOL,
  createWebSearchProvider,
  normalizeResults,
  presetFor,
  searchRequestFor,
};
