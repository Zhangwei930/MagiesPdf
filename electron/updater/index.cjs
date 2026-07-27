const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const {
  applyFeed,
  detectPreferredFeed,
  pickFeeds,
  resolveUpdateChannel,
} = require('./releaseChannel.cjs');

/**
 * Auto-update over MagiesTerminal-style dual feeds.
 *
 * Two feeds carry identical artefacts (see `releaseChannel.cjs`):
 *   - GitHub Releases — preferred overseas
 *   - Cloudflare mirror at dl.magies.top/magiespdf/stable — preferred in
 *     mainland China (locale/timezone heuristic)
 *
 * The preferred feed is tried first; on failure the other is used so a blocked
 * GitHub or a mirror hiccup degrades to a slower check rather than no updates.
 *
 * Windows arm64 uses channel `latest-arm64` so its yml never clobbers x64.
 *
 * Nothing installs itself: the user is told an update exists and chooses.
 */

const CHECK_DELAY_MS = 8000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let started = false;

function currentFeeds() {
  return pickFeeds({
    locale: app.getLocale(),
    platform: process.platform,
    arch: process.arch,
  });
}

/**
 * checkForUpdates on the region-preferred feed, retrying once on the other
 * feed when the preferred one fails — same control flow as MagiesTerminal's
 * `checkForUpdatesWithFallback`.
 *
 * @param {(status: { state: string, message?: string, version?: string }) => void} [onStatus]
 */
async function checkWithFallback(onStatus) {
  const preferred = detectPreferredFeed({ locale: app.getLocale() });
  const order = preferred === 'mirror' ? ['mirror', 'github'] : ['github', 'mirror'];
  const failures = [];

  // Keep channel in sync before the first setFeedURL (generic provider reads it).
  try {
    autoUpdater.channel = resolveUpdateChannel();
  } catch {
    // ignore
  }

  for (const feedId of order) {
    try {
      applyFeed(autoUpdater, feedId);
      const result = await autoUpdater.checkForUpdates();
      return result;
    } catch (error) {
      // A blocked or misconfigured feed is expected on some networks — that is
      // the entire reason a second one exists. Only give up after both fail.
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${feedId}: ${message}`);
      console.warn(
        `[MagiesPdf/updater] ${feedId} feed check failed (${message});` +
          (feedId === order[0] ? ` retrying via ${order[1]}` : ' no feeds left'),
      );
    }
  }

  onStatus?.({
    state: 'error',
    message: `All update feeds failed — ${failures.join('; ')}`,
  });
  return null;
}

/**
 * @param {(status: { state: string, message?: string, version?: string }) => void} onStatus
 */
function startUpdater(onStatus) {
  if (started) return;
  // A dev run has no code signature and no packaged app to replace.
  if (!app.isPackaged) return;
  started = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  try {
    autoUpdater.channel = resolveUpdateChannel();
  } catch {
    // ignore
  }

  autoUpdater.on('update-available', (info) => {
    onStatus?.({ state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => onStatus?.({ state: 'current' }));
  autoUpdater.on('download-progress', (progress) => {
    onStatus?.({ state: 'downloading', message: `${Math.round(progress.percent)}%` });
  });
  autoUpdater.on('update-downloaded', (info) => {
    onStatus?.({ state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (error) => {
    onStatus?.({ state: 'error', message: error.message });
  });

  setTimeout(() => void checkWithFallback(onStatus), CHECK_DELAY_MS);
  setInterval(() => void checkWithFallback(onStatus), RECHECK_INTERVAL_MS);
}

function downloadUpdate() {
  if (!app.isPackaged) {
    return Promise.reject(new Error('Updates are only available in packaged builds'));
  }
  // Feed URL was set by the last successful check; re-assert channel for safety.
  try {
    autoUpdater.channel = resolveUpdateChannel();
  } catch {
    // ignore
  }
  return autoUpdater.downloadUpdate();
}

function quitAndInstall() {
  if (!app.isPackaged) return;
  autoUpdater.quitAndInstall();
}

/**
 * Manual check from Settings. In dev, reports "current" so the UI can be exercised
 * without a published feed. No code signing is required — open-source builds are
 * unsigned by design.
 */
async function checkNow(onStatus) {
  if (!app.isPackaged) {
    onStatus?.({
      state: 'current',
      version: app.getVersion(),
      message: 'dev-build',
    });
    return null;
  }
  onStatus?.({ state: 'checking' });
  return checkWithFallback(onStatus);
}

module.exports = {
  startUpdater,
  checkWithFallback,
  checkNow,
  downloadUpdate,
  quitAndInstall,
  currentFeeds,
  // Re-export for tests that exercise the MagiesTerminal dual-link surface.
  applyFeed,
  detectPreferredFeed,
  resolveUpdateChannel,
};
