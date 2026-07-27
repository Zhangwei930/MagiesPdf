/**
 * Dual-link release channel selection — same model as MagiesTerminal
 * (`MgTerminal/electron/bridges/autoUpdateBridge.cjs` +
 * `infrastructure/services/updateMirror.ts`).
 *
 * Release assets live in a separate public repo and are served two ways:
 *
 *   - Overseas: GitHub Releases CDN (free egress, fast).
 *   - Mainland China: Cloudflare Worker / R2 mirror at dl.magies.top, because
 *     GitHub release downloads there are unreliable to the point of unusable.
 *
 * Detection is client-side and deliberately cheap — the app's own locale and
 * time zone — so a first-run update check never depends on a geo service being
 * reachable. Getting it wrong costs a slower download, never a broken one:
 * both sources carry identical artefacts, and `pickFeeds` always returns both
 * so the updater can fall back to the other.
 *
 * Product path is `/magiespdf/stable` (MagiesTerminal uses `/stable`) so the
 * two products share the host without clobbering each other's latest*.yml.
 */

const RELEASE_OWNER = 'Zhangwei930';
const RELEASE_REPO = 'MagiesPdf';

/** Cloudflare-fronted mirror host shared with MagiesTerminal. */
const MIRROR_HOST = 'dl.magies.top';
/** Product-scoped stable feed root (latest*.yml + artefacts). */
const MIRROR_BASE = `https://${MIRROR_HOST}/magiespdf/stable`;
/** Optional JSON manifest for renderer-side version banners (same dual-link). */
const MIRROR_MANIFEST_URL = `${MIRROR_BASE}/release.json`;
const GITHUB_API_LATEST = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases`;
const GITHUB_BASE = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest/download`;

/** IANA zones that indicate mainland China. Hong Kong and Taipei are excluded. */
const CN_TIMEZONES = new Set(['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Harbin']);

/**
 * Region heuristic matching MagiesTerminal's `shouldPreferMirrorFeed` /
 * `shouldPreferMirror`: zh-CN locale or a mainland time zone.
 *
 * @param {{ locale?: string, timeZone?: string, country?: string | null }} input
 * @returns {boolean} true when the mirror should be tried first
 */
function preferMirror(input = {}) {
  if (input.country === 'CN') return true;

  const locale = (input.locale || '').trim();
  // MagiesTerminal matches /^zh-CN/i; also accept zh-Hans* (common on Windows).
  if (/^zh[-_]CN\b/i.test(locale) || /^zh[-_]Hans\b/i.test(locale)) return true;

  const timeZone = input.timeZone || resolveTimeZone();
  return CN_TIMEZONES.has(timeZone);
}

function resolveTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    // Some minimal Linux containers ship without tz data.
    return '';
  }
}

/**
 * Windows arm64 publishes to channel "latest-arm64" (latest-arm64.yml) so it
 * cannot clobber x64 latest.yml — same as MagiesTerminal.
 *
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {'latest' | 'latest-arm64'}
 */
function resolveUpdateChannel(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'arm64') return 'latest-arm64';
  return 'latest';
}

/**
 * Preferred feed id for logging / fallback ordering.
 * @param {{ locale?: string, timeZone?: string, country?: string | null }} [input]
 * @returns {'mirror' | 'github'}
 */
function detectPreferredFeed(input = {}) {
  return preferMirror(input) ? 'mirror' : 'github';
}

/**
 * Build a single feed descriptor for electron-updater's `setFeedURL`.
 *
 * @param {'mirror' | 'github'} feed
 * @param {string} [channel]
 * @returns {{ provider: string, url?: string, owner?: string, repo?: string, channel: string }}
 */
function buildFeed(feed, channel = resolveUpdateChannel()) {
  if (feed === 'mirror') {
    return { provider: 'generic', url: MIRROR_BASE, channel };
  }
  return {
    provider: 'github',
    owner: RELEASE_OWNER,
    repo: RELEASE_REPO,
    channel,
  };
}

/**
 * Update feeds in the order they should be tried (preferred first, other as
 * fallback). Always length 2.
 *
 * @param {{
 *   locale?: string,
 *   timeZone?: string,
 *   country?: string | null,
 *   platform?: string,
 *   arch?: string,
 *   channel?: string,
 * }} [input]
 * @returns {Array<{ provider: string, url?: string, owner?: string, repo?: string, channel: string }>}
 */
function pickFeeds(input = {}) {
  const channel =
    input.channel || resolveUpdateChannel(input.platform, input.arch);
  const github = buildFeed('github', channel);
  const mirror = buildFeed('mirror', channel);
  return preferMirror(input) ? [mirror, github] : [github, mirror];
}

/**
 * Apply feed + channel to an electron-updater instance (MagiesTerminal
 * `applyFeed` shape).
 *
 * @param {{ channel?: string, setFeedURL: (opts: object) => void }} updater
 * @param {'mirror' | 'github' | object} feed  id or full feed object
 * @param {{ platform?: string, arch?: string }} [opts]
 */
function applyFeed(updater, feed, opts = {}) {
  const channel = resolveUpdateChannel(opts.platform, opts.arch);
  try {
    updater.channel = channel;
  } catch {
    // Older electron-updater stubs in tests may not expose channel.
  }
  const descriptor =
    typeof feed === 'string' ? buildFeed(feed, channel) : { ...feed, channel };
  updater.setFeedURL(descriptor);
  return descriptor;
}

function buildMirrorUrl(fileName) {
  return `${MIRROR_BASE}/${encodeURIComponent(fileName)}`;
}

function buildGithubUrl(fileName) {
  return `${GITHUB_BASE}/${encodeURIComponent(fileName)}`;
}

/**
 * Guards anything the app is about to open or download. An update manifest is
 * remote input; without this a compromised or spoofed feed could point the app
 * at an arbitrary host.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isSafeDownloadTarget(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;

    if (parsed.hostname === MIRROR_HOST) {
      return parsed.pathname.startsWith('/magiespdf/stable/');
    }
    if (parsed.hostname === 'github.com') {
      // Both the tagged form (`/releases/download/v1.2.3/…`) and the rolling
      // "latest" alias (`/releases/latest/download/…`) are legitimate — the
      // updater resolves tags, while the download page links to latest.
      const prefix = `/${RELEASE_OWNER}/${RELEASE_REPO}/releases/`;
      if (!parsed.pathname.startsWith(prefix)) return false;
      const rest = parsed.pathname.slice(prefix.length);
      return rest.startsWith('download/') || rest.startsWith('latest/download/');
    }
    if (parsed.hostname === 'objects.githubusercontent.com') {
      // GitHub's release CDN, which browser_download_url redirects to.
      return true;
    }
    if (parsed.hostname === 'api.github.com') {
      // Renderer dual-link version check hits the Releases API.
      return parsed.pathname.startsWith(`/repos/${RELEASE_OWNER}/${RELEASE_REPO}/`);
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  RELEASE_OWNER,
  RELEASE_REPO,
  MIRROR_HOST,
  MIRROR_BASE,
  MIRROR_MANIFEST_URL,
  GITHUB_API_LATEST,
  GITHUB_RELEASES_PAGE,
  GITHUB_BASE,
  CN_TIMEZONES,
  preferMirror,
  detectPreferredFeed,
  resolveUpdateChannel,
  buildFeed,
  pickFeeds,
  applyFeed,
  buildMirrorUrl,
  buildGithubUrl,
  isSafeDownloadTarget,
};
