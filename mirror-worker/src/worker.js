/**
 * dl.magies.top/magiespdf — mainland-China download/update mirror for MagiesPdf.
 *
 * Same dual-link model as MagiesTerminal's mirror-worker:
 * a Cloudflare Worker that proxies GitHub Releases in real time (no storage).
 *
 *   GET /magiespdf/stable/release.json  -> manifest from GitHub API latest
 *   GET /magiespdf/stable/<asset>       -> stream latest-release asset
 *   GET /magiespdf/stable/latest*.yml   -> electron-updater metadata
 *
 * Deploy: `npx wrangler deploy` from this directory.
 * Route is product-scoped so it coexists with MagiesTerminal's /stable worker.
 */

/* global fetch, Response, Headers, URL */

const REPO = 'Zhangwei930/MagiesPdf';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const PREFIX = '/magiespdf/stable';
const MANIFEST_TTL_SECONDS = 300;
const ASSET_TTL_SECONDS = 3600;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
};

/** Map the GitHub API release payload to the mirror manifest schema. */
export function buildManifest(apiRelease, origin) {
  const tag = String(apiRelease.tag_name || '');
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    publishedAt: apiRelease.published_at || '',
    files: (apiRelease.assets || []).map((asset) => ({
      name: asset.name,
      size: asset.size ?? 0,
      url: `${origin}${PREFIX}/${asset.name}`,
    })),
  };
}

/**
 * Extract the asset filename from /magiespdf/stable/<name>; null for anything else.
 * @param {string} pathname
 * @returns {string | null}
 */
export function resolveAssetName(pathname) {
  const match = new RegExp(`^${PREFIX}/([^/]+)$`).exec(pathname);
  if (!match) return null;
  const name = decodeURIComponent(match[1]);
  if (!name || name === 'release.json') return null;
  return name;
}

async function serveManifest(origin) {
  const upstream = await fetch(API_LATEST, {
    headers: {
      'User-Agent': 'magiespdf-mirror-worker',
      Accept: 'application/vnd.github+json',
    },
    cf: { cacheTtl: MANIFEST_TTL_SECONDS, cacheEverything: true },
  });
  if (!upstream.ok) {
    return new Response(`GitHub API ${upstream.status}`, { status: 502, headers: CORS_HEADERS });
  }
  const manifest = buildManifest(await upstream.json(), origin);
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${MANIFEST_TTL_SECONDS}`,
    },
  });
}

async function serveAsset(name, request) {
  // Forward Range so electron-updater differential downloads and resumed
  // downloads get 206 partial responses instead of the whole file.
  const upstreamHeaders = {};
  const range = request.headers.get('Range');
  if (range) upstreamHeaders.Range = range;

  const upstream = await fetch(
    `https://github.com/${REPO}/releases/latest/download/${encodeURIComponent(name)}`,
    {
      headers: upstreamHeaders,
      redirect: 'follow',
      cf: range ? undefined : { cacheTtl: ASSET_TTL_SECONDS, cacheEverything: true },
    },
  );
  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`upstream ${upstream.status}`, {
      status: upstream.status === 404 ? 404 : 502,
      headers: CORS_HEADERS,
    });
  }
  const headers = new Headers(upstream.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }
    if (url.pathname === `${PREFIX}/release.json`) {
      return serveManifest(url.origin);
    }
    const assetName = resolveAssetName(url.pathname);
    if (assetName) {
      return serveAsset(assetName, request);
    }
    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};
