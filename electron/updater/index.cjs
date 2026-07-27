const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const settings = require('../settings.cjs');
const {
  applyFeed,
  detectPreferredFeed,
  pickFeeds,
  resolveUpdateChannel,
  RELEASE_OWNER,
  RELEASE_REPO,
} = require('./releaseChannel.cjs');

/**
 * Auto-update over MagiesTerminal-style dual feeds.
 *
 * Two feeds carry identical artefacts (see `releaseChannel.cjs`):
 *   - GitHub Releases — Zhangwei930/MagiesPdf
 *   - Cloudflare mirror at dl.magies.top/magiespdf/stable
 *
 * Preferred feed first; the other is always the fallback. Windows arm64 uses
 * channel `latest-arm64`. Updates are checked automatically but downloaded and
 * installed only after explicit user actions.
 */

const CHECK_DELAY_MS = 8000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let started = false;
/** @type {((status: object) => void) | null} */
let statusSink = null;

function readAutoUpdateEnabled() {
  try {
    return settings.read().autoUpdate !== false;
  } catch {
    return true;
  }
}

function enforceManualUpdate() {
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
  } catch {
    // ignore
  }
}

function setAutoDownloadEnabled() {
  enforceManualUpdate();
}

function currentFeeds() {
  return pickFeeds({
    locale: app.getLocale(),
    platform: process.platform,
    arch: process.arch,
  });
}

/**
 * Short bilingual-friendly message for the UI (not the raw electron-updater dump).
 * @param {string} feedId
 * @param {unknown} error
 */
function summarizeFeedError(feedId, error) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/404|ENOENT|Cannot find channel/i.test(raw)) {
    return `${feedId}: 404 (feed not available)`;
  }
  if (/TIMED_OUT|ECONN|ENOTFOUND|network|offline/i.test(raw)) {
    return `${feedId}: network error`;
  }
  // Keep first line only — drop Headers / stack noise.
  const first = raw.split('\n')[0].slice(0, 160);
  return `${feedId}: ${first}`;
}

/**
 * @param {(status: { state: string, message?: string, version?: string }) => void} [onStatus]
 */
async function checkWithFallback(onStatus) {
  const preferred = detectPreferredFeed({ locale: app.getLocale() });
  // Always try GitHub as a solid fallback; mirror may not be deployed yet.
  const order = preferred === 'mirror' ? ['mirror', 'github'] : ['github', 'mirror'];
  const failures = [];

  try {
    autoUpdater.channel = resolveUpdateChannel();
  } catch {
    // ignore
  }

  for (const feedId of order) {
    try {
      applyFeed(autoUpdater, feedId);
      console.log(
        `[MagiesPdf/updater] checking via ${feedId}` +
          (feedId === 'github' ? ` (${RELEASE_OWNER}/${RELEASE_REPO})` : ''),
      );
      const result = await autoUpdater.checkForUpdates();
      return result;
    } catch (error) {
      const summary = summarizeFeedError(feedId, error);
      failures.push(summary);
      console.warn(
        `[MagiesPdf/updater] ${summary};` +
          (feedId === order[0] ? ` retrying via ${order[1]}` : ' no feeds left'),
      );
    }
  }

  onStatus?.({
    state: 'error',
    message: failures.join(' · '),
  });
  return null;
}

/**
 * @param {(status: { state: string, message?: string, version?: string }) => void} onStatus
 */
function startUpdater(onStatus) {
  if (started) return;
  if (!app.isPackaged) return;
  started = true;
  statusSink = onStatus;

  enforceManualUpdate();
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
    // checkWithFallback already reports dual-feed failure; avoid double-noise
    // for expected check-phase 404s.
    const message = error?.message || String(error);
    if (/404|Cannot find channel/i.test(message)) return;
    onStatus?.({ state: 'error', message: message.split('\n')[0].slice(0, 200) });
  });

  if (readAutoUpdateEnabled()) {
    setTimeout(() => void checkWithFallback(onStatus), CHECK_DELAY_MS);
    setInterval(() => {
      if (readAutoUpdateEnabled()) void checkWithFallback(onStatus);
    }, RECHECK_INTERVAL_MS);
  }
}

function downloadUpdate() {
  if (!app.isPackaged) {
    return Promise.reject(new Error('Updates are only available in packaged builds'));
  }
  try {
    autoUpdater.channel = resolveUpdateChannel();
  } catch {
    // ignore
  }
  enforceManualUpdate();
  return autoUpdater.downloadUpdate();
}

function quitAndInstall() {
  if (!app.isPackaged) return;
  autoUpdater.quitAndInstall();
}

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

/**
 * Called when Settings → autoUpdate changes.
 * @param {boolean} enabled
 */
function onAutoUpdatePreferenceChanged(enabled) {
  setAutoDownloadEnabled(enabled);
  if (enabled && app.isPackaged && statusSink) {
    void checkWithFallback(statusSink);
  }
}

module.exports = {
  startUpdater,
  checkWithFallback,
  checkNow,
  downloadUpdate,
  quitAndInstall,
  currentFeeds,
  onAutoUpdatePreferenceChanged,
  setAutoDownloadEnabled,
  enforceManualUpdate,
  applyFeed,
  detectPreferredFeed,
  resolveUpdateChannel,
};
