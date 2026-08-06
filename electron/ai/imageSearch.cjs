'use strict';

/**
 * Pictures for a document, offered to the Agent as one tool.
 *
 * A deck of charts and bullet lists still reads as a deck of charts and bullet
 * lists; a cover image is what the user means by "make it look good". Magies
 * could not produce one, so the agent left slides text-only or asked the user
 * for a file.
 *
 * Two ways to get a picture, because one of them does not work everywhere:
 *
 * - **search** a stock library (Pexels). Free for commercial use, no attribution
 *   required — the licence that survives contact with a client deck. Its API is
 *   not reliably reachable from mainland China.
 * - **generate** one through any OpenAI-compatible images endpoint. This is the
 *   route that works from the mainland (Zhipu, SiliconFlow, DashScope-compatible
 *   gateways all speak it), and it also covers "draw me something" outright.
 *
 * The rules are the same as web search, because this also leaves the machine:
 * off unless configured, withdrawn entirely under strict local privacy, and
 * whatever comes back is written only inside the granted workspace.
 */

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_RESULTS = 4;

const IMAGE_CONTENT_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

const IMAGE_PROVIDER_PRESETS = Object.freeze([
  {
    id: 'pexels',
    name: 'Pexels',
    kind: 'search',
    endpoint: 'https://api.pexels.com/v1/search',
    requiresApiKey: true,
    requiresModel: false,
    hint: {
      zh: '免费图库，可商用免署名；中国大陆通常连不上',
      en: 'Free stock library, commercial use without attribution; often unreachable from mainland China',
    },
  },
  {
    id: 'zhipu',
    name: '智谱 CogView',
    kind: 'generate',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    defaultModel: 'cogview-3-flash',
    requiresApiKey: true,
    requiresModel: true,
    hint: { zh: '国内可直连，按提示词生成', en: 'Reachable from mainland China, generates from a prompt' },
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    kind: 'generate',
    endpoint: 'https://api.siliconflow.cn/v1/images/generations',
    defaultModel: 'Kwai-Kolors/Kolors',
    requiresApiKey: true,
    requiresModel: true,
    hint: { zh: '国内可直连，多种开源模型', en: 'Reachable from mainland China, open models' },
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI 兼容端点',
    kind: 'generate',
    endpoint: '',
    defaultModel: '',
    requiresApiKey: true,
    requiresModel: true,
    hint: { zh: '自填地址，任何 /images/generations 接口', en: 'Any /images/generations endpoint you name' },
  },
]);

function presetFor(providerId) {
  return IMAGE_PROVIDER_PRESETS.find((preset) => preset.id === providerId) ?? null;
}

/**
 * Picture generation on the model provider the user already configured.
 *
 * A second API key is the hurdle nobody clears, so on most installations this
 * feature would simply not exist. But a user must configure a model provider to
 * use the assistant at all, and several of those serve `/images/generations`
 * from the same base URL under the same key — which makes a picture free of
 * setup for the people who can have one.
 *
 * Only families whose image model id is known are listed. Guessing one would
 * produce a 404 the user never sees, and that is worse than the drawn figure
 * `office_presentation_compose` falls back to.
 */
const MODEL_PROVIDER_IMAGES = Object.freeze([
  { host: 'open.bigmodel.cn', preset: 'zhipu', model: 'cogview-3-flash' },
  { host: 'api.siliconflow.cn', preset: 'siliconflow', model: 'Kwai-Kolors/Kolors' },
  { host: 'api.openai.com', preset: 'openai-compatible', model: 'gpt-image-1' },
  { host: 'api.x.ai', preset: 'openai-compatible', model: 'grok-2-image' },
]);

function imagesFromModelProvider(provider) {
  if (!provider || !provider.apiKey) return null;
  let host;
  try {
    host = new URL(String(provider.baseUrl || '')).hostname.toLowerCase();
  } catch {
    return null;
  }
  const family = MODEL_PROVIDER_IMAGES.find((entry) => entry.host === host);
  if (!family) return null;
  return {
    provider: family.preset,
    endpoint: `${String(provider.baseUrl).replace(/\/+$/, '')}/images/generations`,
    model: family.model,
    apiKey: provider.apiKey,
  };
}

const IMAGE_TOOL = Object.freeze({
  functionName: 'office_image_search',
  toolId: 'office:image:search',
  name: { zh: '获取配图', en: 'Get a picture' },
  requiresApproval: true,
  unattended: true,
  providerTool: {
    type: 'function',
    function: {
      name: 'office_image_search',
      description:
        'Get a picture and save it into the granted workspace, then use the returned relative path '
        + 'with the image layout of office_presentation_compose or with office_word_insert_image. '
        + 'Depending on how the user configured it this either searches a stock library or generates '
        + 'the picture. Use it for a cover or a mood shot; anything carrying data says more as a chart.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            minLength: 2,
            maxLength: 400,
            description: 'What the picture shows. Searching indexes English; generating takes any '
              + 'language and rewards a descriptive sentence (subject, setting, mood, style).',
          },
          count: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: 'Defaults to 1.' },
          orientation: { type: 'string', enum: ['landscape', 'portrait', 'square'] },
          directory: {
            type: 'string',
            maxLength: 200,
            description: 'Workspace-relative folder to save into. Defaults to "Images".',
          },
        },
        required: ['query'],
      },
    },
  },
});

/** `city skyline at dusk` → `city-skyline-at-dusk`, bounded and path-safe. */
function fileStem(query, index) {
  const slug = String(query)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const base = slug || 'image';
  return index === 0 ? base : `${base}-${index + 1}`;
}

/** Generation endpoints take a pixel size; searching takes an orientation. */
function generationSize(orientation) {
  if (orientation === 'portrait') return '1024x1536';
  if (orientation === 'square') return '1024x1024';
  return '1536x1024';
}

function imageRequest(config, { query, count, orientation }) {
  const preset = presetFor(config.provider);
  if (!preset) throw new Error(`Unknown picture provider: ${config.provider}`);
  const endpoint = String(config.endpoint || preset.endpoint || '').trim();
  if (!endpoint) throw new Error('This picture provider needs an endpoint address');

  if (preset.kind === 'search') {
    const url = new URL(endpoint);
    url.searchParams.set('query', query);
    url.searchParams.set('per_page', String(count));
    if (orientation) url.searchParams.set('orientation', orientation);
    // The key goes in a header: a query string ends up in proxy logs.
    return { url: url.href, init: { method: 'GET', headers: { Authorization: config.apiKey } } };
  }

  return {
    url: endpoint,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: String(config.model || preset.defaultModel || ''),
        prompt: query,
        n: count,
        size: generationSize(orientation),
      }),
    },
  };
}

/** Both shapes reduce to: where do I download it, and what should I credit. */
function normalizeImages(providerId, payload) {
  const preset = presetFor(providerId);
  if (preset?.kind === 'search') {
    const photos = Array.isArray(payload?.photos) ? payload.photos : [];
    return photos.flatMap((photo) => {
      const source = photo?.src?.large2x || photo?.src?.large || photo?.src?.original || '';
      if (typeof source !== 'string' || source === '') return [];
      return [{
        downloadUrl: source,
        base64: '',
        width: Number(photo.width) || 0,
        height: Number(photo.height) || 0,
        credit: String(photo.photographer || '').slice(0, 120),
        source: String(photo.url || '').slice(0, 300),
      }];
    });
  }
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.flatMap((entry) => {
    const url = typeof entry?.url === 'string' ? entry.url : '';
    const base64 = typeof entry?.b64_json === 'string' ? entry.b64_json : '';
    if (!url && !base64) return [];
    return [{
      downloadUrl: url,
      base64,
      width: 0,
      height: 0,
      credit: '',
      source: url.slice(0, 300),
    }];
  });
}

/**
 * Where a download may point.
 *
 * Searching only ever downloads from the stock library's own image host. A
 * generation endpoint hands back a URL on whatever CDN that vendor uses, which
 * cannot be known in advance — there the guard is that the user configured this
 * endpoint, the address must be https, and the response still has to be an
 * image within the size limit.
 */
function assertDownloadable(providerId, downloadUrl) {
  let parsed;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw new Error('The picture provider returned an address that is not a URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Pictures are only downloaded over https');
  }
  if (providerId === 'pexels' && parsed.hostname !== 'images.pexels.com') {
    throw new Error(`Refusing to download an image from ${parsed.hostname}`);
  }
  return parsed.href;
}

function createImageSearchProvider({ readConfig, saveImage, fetch: fetchImpl = globalThis.fetch } = {}) {
  /**
   * The configuration a call will actually run against. 'auto' means "whatever
   * the configured model provider can serve", and resolves to nothing when it
   * cannot — which withdraws the tool rather than offering a broken one.
   */
  const resolveConfig = () => {
    const config = readConfig() || {};
    if (config.provider !== 'auto') return config;
    return { ...config, ...(imagesFromModelProvider(config.modelProvider) ?? { provider: '' }) };
  };

  const usable = (config) => {
    if (!config?.enabled || config.strictLocalPrivacy) return false;
    const preset = presetFor(config.provider);
    if (!preset) return false;
    if (preset.requiresApiKey && !config.apiKey) return false;
    if (!String(config.endpoint || preset.endpoint || '').trim()) return false;
    if (preset.requiresModel && !String(config.model || preset.defaultModel || '').trim()) return false;
    return true;
  };

  return {
    async listTools() {
      return usable(resolveConfig()) ? [{ ...IMAGE_TOOL }] : [];
    },

    async callTool(functionName, args = {}, { signal } = {}) {
      if (functionName !== IMAGE_TOOL.functionName) {
        throw new Error(`Unknown image tool: ${functionName}`);
      }
      const config = resolveConfig();
      if (config?.strictLocalPrivacy) {
        throw new Error('Strict local privacy is on, so pictures cannot be fetched');
      }
      if (!usable(config)) {
        throw new Error('Set up a picture provider in Settings → AI first');
      }

      const query = String(args.query ?? '').trim();
      if (query.length < 2) throw new Error('A description of at least two characters is required');
      const count = Math.min(Math.max(Number(args.count) || 1, 1), MAX_RESULTS);
      const orientation = ['landscape', 'portrait', 'square'].includes(args.orientation)
        ? args.orientation
        : '';
      const directory = String(args.directory || 'Images').trim() || 'Images';

      const { url, init } = imageRequest(config, { query, count, orientation });
      const response = await fetchImpl(url, { ...init, signal });
      if (!response.ok) {
        throw new Error(`The picture provider answered HTTP ${response.status}`);
      }
      const candidates = normalizeImages(config.provider, await response.json()).slice(0, count);
      if (candidates.length === 0) throw new Error(`No picture came back for "${query}"`);

      const images = [];
      for (const [index, candidate] of candidates.entries()) {
        let bytes;
        let extension;
        if (candidate.base64) {
          bytes = Buffer.from(candidate.base64, 'base64');
          extension = '.png';
        } else {
          const href = assertDownloadable(config.provider, candidate.downloadUrl);
          const download = await fetchImpl(href, { signal });
          if (!download.ok) throw new Error(`Downloading the picture failed with HTTP ${download.status}`);
          const contentType = String(download.headers?.get?.('content-type') || '')
            .split(';')[0]
            .trim()
            .toLowerCase();
          extension = IMAGE_CONTENT_TYPES.get(contentType);
          if (!extension) {
            throw new Error(`The provider returned ${contentType || 'an unknown type'}, not an image`);
          }
          bytes = Buffer.from(await download.arrayBuffer());
        }
        if (bytes.length === 0) throw new Error('The provider returned an empty image');
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error('The picture is larger than 12 MB');

        images.push({
          path: await saveImage(directory, fileStem(query, index), extension, bytes),
          width: candidate.width,
          height: candidate.height,
          credit: candidate.credit,
          source: candidate.source,
        });
      }
      return { query, images };
    },
  };
}

module.exports = {
  IMAGE_PROVIDER_PRESETS,
  IMAGE_TOOL,
  MAX_IMAGE_BYTES,
  assertDownloadable,
  createImageSearchProvider,
  fileStem,
  imageRequest,
  imagesFromModelProvider,
  normalizeImages,
};
