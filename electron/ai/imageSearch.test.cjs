'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  IMAGE_PROVIDER_PRESETS,
  assertDownloadable,
  createImageSearchProvider,
  fileStem,
  imageRequest,
  imagesFromModelProvider,
  normalizeImages,
} = require('./imageSearch.cjs');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function imageResponse(body = PNG, contentType = 'image/png') {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : '') },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, headers: { get: () => '' } };
}

const saved = [];
const saveImage = async (directory, stem, extension) => {
  saved.push(`${directory}/${stem}${extension}`);
  return `${directory}/${stem}${extension}`;
};

describe('picture providers', () => {
  it('offers a mainland-reachable route as well as the stock library', () => {
    // Pexels is unreachable from mainland China, so a provider that only ever
    // searched it would be a feature that does not exist for half the users.
    const generators = IMAGE_PROVIDER_PRESETS.filter((preset) => preset.kind === 'generate');
    assert.ok(generators.length >= 2);
    assert.ok(generators.some((preset) => preset.endpoint.includes('bigmodel.cn')));
    assert.ok(generators.some((preset) => preset.endpoint.includes('siliconflow.cn')));
  });

  it('sends the key in a header, never in the query string', () => {
    const { url, init } = imageRequest(
      { provider: 'pexels', apiKey: 'secret-key' },
      { query: 'city skyline', count: 2, orientation: 'landscape' },
    );
    assert.match(url, /query=city\+skyline/);
    assert.match(url, /per_page=2/);
    assert.doesNotMatch(url, /secret-key/);
    assert.equal(init.headers.Authorization, 'secret-key');
  });

  it('asks a generation endpoint in the OpenAI shape', () => {
    const { url, init } = imageRequest(
      { provider: 'zhipu', apiKey: 'k', model: 'cogview-3-flash' },
      { query: '晨光中的城市天际线', count: 1, orientation: 'portrait' },
    );
    assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/images/generations');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'cogview-3-flash');
    assert.equal(body.prompt, '晨光中的城市天际线');
    assert.equal(body.size, '1024x1536');
    assert.equal(init.headers.authorization, 'Bearer k');
  });

  it('reads both payload shapes', () => {
    const searched = normalizeImages('pexels', {
      photos: [{ src: { large2x: 'https://images.pexels.com/a.jpg' }, width: 4, height: 3, photographer: 'Ada' }],
    });
    assert.equal(searched[0].downloadUrl, 'https://images.pexels.com/a.jpg');
    assert.equal(searched[0].credit, 'Ada');

    const generated = normalizeImages('zhipu', { data: [{ url: 'https://cdn.example/a.png' }, { b64_json: 'AAAA' }] });
    assert.equal(generated[0].downloadUrl, 'https://cdn.example/a.png');
    assert.equal(generated[1].base64, 'AAAA');
  });

  it('downloads only over https, and only from the library it searched', () => {
    assert.throws(() => assertDownloadable('pexels', 'http://images.pexels.com/a.jpg'), /https/);
    assert.throws(() => assertDownloadable('pexels', 'https://evil.example/a.jpg'), /Refusing/);
    // A generation vendor's CDN cannot be known in advance; https still is.
    assert.equal(
      assertDownloadable('zhipu', 'https://sfile.chatglm.cn/a.png'),
      'https://sfile.chatglm.cn/a.png',
    );
    assert.throws(() => assertDownloadable('zhipu', 'http://sfile.chatglm.cn/a.png'), /https/);
  });

  it('stays hidden until it is configured, and under strict local privacy', async () => {
    const off = createImageSearchProvider({ readConfig: () => ({ enabled: false }), saveImage });
    assert.deepEqual(await off.listTools(), []);

    const keyless = createImageSearchProvider({
      readConfig: () => ({ enabled: true, provider: 'pexels', apiKey: '' }),
      saveImage,
    });
    assert.deepEqual(await keyless.listTools(), []);

    const private_ = createImageSearchProvider({
      readConfig: () => ({ enabled: true, provider: 'pexels', apiKey: 'k', strictLocalPrivacy: true }),
      saveImage,
    });
    assert.deepEqual(await private_.listTools(), []);
    await assert.rejects(
      () => private_.callTool('office_image_search', { query: 'city' }),
      /Strict local privacy/,
    );
  });

  it('saves what it fetched into the workspace and reports the path', async () => {
    saved.length = 0;
    const calls = [];
    const provider = createImageSearchProvider({
      readConfig: () => ({ enabled: true, provider: 'pexels', apiKey: 'k' }),
      saveImage,
      fetch: async (url) => {
        calls.push(url);
        if (url.startsWith('https://api.pexels.com')) {
          return jsonResponse({
            photos: [{ src: { large2x: 'https://images.pexels.com/a.jpg' }, width: 1200, height: 800, photographer: 'Ada' }],
          });
        }
        return imageResponse(PNG, 'image/jpeg');
      },
    });

    const result = await provider.callTool('office_image_search', { query: 'City skyline' });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].path, 'Images/city-skyline.jpg');
    assert.equal(result.images[0].credit, 'Ada');
    assert.deepEqual(saved, ['Images/city-skyline.jpg']);
  });

  it('takes base64 straight from a generator, with no second request', async () => {
    saved.length = 0;
    let requests = 0;
    const provider = createImageSearchProvider({
      readConfig: () => ({ enabled: true, provider: 'siliconflow', apiKey: 'k', model: 'Kolors' }),
      saveImage,
      fetch: async () => {
        requests += 1;
        return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] });
      },
    });

    const result = await provider.callTool('office_image_search', { query: '会议室', directory: '素材' });
    assert.equal(requests, 1, 'inline bytes need no download');
    assert.equal(result.images[0].path, '素材/会议室.png');
  });

  it('refuses anything that is not an image', async () => {
    const provider = createImageSearchProvider({
      readConfig: () => ({ enabled: true, provider: 'pexels', apiKey: 'k' }),
      saveImage,
      fetch: async (url) => (url.startsWith('https://api.pexels.com')
        ? jsonResponse({ photos: [{ src: { large2x: 'https://images.pexels.com/a.jpg' } }] })
        : imageResponse(Buffer.from('<html>'), 'text/html')),
    });
    await assert.rejects(
      () => provider.callTool('office_image_search', { query: 'city' }),
      /not an image/,
    );
  });

  it('borrows the picture endpoint from the model provider already configured', () => {
    // The second key is the hurdle nobody clears. Several of the providers a
    // user must configure anyway serve /images/generations from the same base
    // URL with the same key, so there is nothing left to set up.
    const derived = imagesFromModelProvider({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'zk',
    });
    assert.equal(derived.endpoint, 'https://open.bigmodel.cn/api/paas/v4/images/generations');
    assert.equal(derived.apiKey, 'zk');
    assert.ok(derived.model);

    // A trailing slash is the user's, not a second path segment.
    assert.equal(
      imagesFromModelProvider({ baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk' }).endpoint,
      'https://api.openai.com/v1/images/generations',
    );

    // A family with no images endpoint, a local model, or no key at all must
    // resolve to nothing: a guessed endpoint that 404s is worse than the drawn
    // figure the deck falls back to.
    assert.equal(imagesFromModelProvider({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'd' }), null);
    assert.equal(imagesFromModelProvider({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'x' }), null);
    assert.equal(imagesFromModelProvider({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }), null);
    assert.equal(imagesFromModelProvider(null), null);
  });

  it("offers the tool on 'auto' only when the model provider can serve it", async () => {
    const calls = [];
    const build = (modelProvider) => createImageSearchProvider({
      readConfig: () => ({ enabled: true, provider: 'auto', modelProvider }),
      saveImage,
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
        return jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] });
      },
    });

    const following = build({ baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sf' });
    assert.equal((await following.listTools()).length, 1);
    await following.callTool('office_image_search', { query: 'a quiet office at dawn' });
    assert.equal(calls[0].url, 'https://api.siliconflow.cn/v1/images/generations');
    assert.equal(calls[0].auth, 'Bearer sf');
    assert.ok(calls[0].body.model);

    const unusable = build({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'd' });
    assert.deepEqual(await unusable.listTools(), []);
    await assert.rejects(
      () => unusable.callTool('office_image_search', { query: 'a quiet office' }),
      /Settings/,
    );
  });

  it('names files safely whatever the phrase was', () => {
    assert.equal(fileStem('City Skyline at Dusk', 0), 'city-skyline-at-dusk');
    assert.equal(fileStem('../../etc/passwd', 0), 'etc-passwd');
    assert.equal(fileStem('会议室 讨论', 1), '会议室-讨论-2');
    assert.equal(fileStem('!!!', 0), 'image');
  });
});
