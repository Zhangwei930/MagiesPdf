const { app, dialog } = require('electron');
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
 * channel `latest-arm64`.
 *
 * When Settings → autoUpdate is on (default): check on launch and
 * auto-download in the background. Installation always waits for an explicit
 * "Restart to install" click — packages are unsigned, so we never install
 * silently. On macOS unsigned builds, Squirrel.Mac cannot install; we swap the
 * .app bundle ourselves (macSelfUpdate.cjs).
 */

const CHECK_DELAY_MS = 8000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let started = false;
/** @type {((status: object) => void) | null} */
let statusSink = null;
/** @type {ReturnType<typeof setInterval> | null} */
let recheckTimer = null;

/**
 * Snapshot of the last known update status so late subscribers (Settings open
 * after the check) can hydrate without waiting for the next event.
 * @type {{ state: string, message?: string, version?: string }}
 */
let lastStatus = { state: 'idle' };

/** Absolute path of the update file electron-updater downloaded (macOS zip). */
let downloadedFile = null;

/** True while a download is in flight (auto or manual). */
let isDownloading = false;

/**
 * Run before the macOS installer swaps the bundle. Wired to the quit cleanup
 * in main.cjs: the worker pool and the editor host read files out of the .app
 * that is about to be renamed away, so they are shut down while it is still
 * there rather than during the quit that follows.
 * @type {(() => Promise<unknown>) | null}
 */
let prepareForInstall = null;

/** @param {() => Promise<unknown>} prepare */
function setInstallPreparation(prepare) {
  prepareForInstall = prepare;
}

function readAutoUpdateEnabled() {
  try {
    return settings.read().autoUpdate !== false;
  } catch {
    return true;
  }
}

/**
 * Install is never automatic. Download follows the Settings preference.
 * @param {boolean} [autoDownload]
 */
function applyDownloadPreference(autoDownload = readAutoUpdateEnabled()) {
  try {
    autoUpdater.autoDownload = autoDownload !== false;
    autoUpdater.autoInstallOnAppQuit = false;
  } catch {
    // ignore
  }
}

/** @deprecated use applyDownloadPreference — kept for tests that call the old name */
function enforceManualUpdate() {
  applyDownloadPreference(false);
}

/** @deprecated use applyDownloadPreference */
function setAutoDownloadEnabled(enabled) {
  applyDownloadPreference(enabled !== false);
}

function currentFeeds() {
  return pickFeeds({
    locale: app.getLocale(),
    platform: process.platform,
    arch: process.arch,
  });
}

/**
 * @param {{ state: string, message?: string, version?: string }} status
 */
function emitStatus(status) {
  lastStatus = { ...status };
  statusSink?.(lastStatus);
}

function getLastStatus() {
  return { ...lastStatus };
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

  const status = {
    state: 'error',
    message: failures.join(' · '),
  };
  if (onStatus) onStatus(status);
  else emitStatus(status);
  return null;
}

function wireUpdaterEvents(onStatus) {
  autoUpdater.on('update-available', (info) => {
    const version = info?.version;
    // When autoDownload is on, electron-updater starts the download immediately.
    // Report downloading so the corner toast and Settings show progress.
    const willDownload = autoUpdater.autoDownload !== false;
    isDownloading = willDownload;
    onStatus?.({
      state: willDownload ? 'downloading' : 'available',
      version,
      message: willDownload ? '0%' : undefined,
    });
  });
  autoUpdater.on('update-not-available', () => onStatus?.({ state: 'current' }));
  autoUpdater.on('download-progress', (progress) => {
    isDownloading = true;
    onStatus?.({
      state: 'downloading',
      version: lastStatus.version,
      message: `${Math.round(progress.percent)}%`,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    isDownloading = false;
    downloadedFile = info?.downloadedFile || downloadedFile;
    onStatus?.({ state: 'ready', version: info?.version || lastStatus.version });
  });
  autoUpdater.on('error', (error) => {
    // checkWithFallback already reports dual-feed failure; avoid double-noise
    // for expected check-phase 404s when nothing was downloading.
    const message = error?.message || String(error);
    if (!isDownloading && /404|Cannot find channel/i.test(message)) return;
    if (isDownloading) isDownloading = false;
    onStatus?.({ state: 'error', message: message.split('\n')[0].slice(0, 200) });
  });
}

/**
 * @param {(status: { state: string, message?: string, version?: string }) => void} onStatus
 */
function startUpdater(onStatus) {
  if (started) return;
  if (!app.isPackaged) return;
  started = true;
  statusSink = (status) => {
    lastStatus = { ...status };
    onStatus?.(lastStatus);
  };

  applyDownloadPreference(readAutoUpdateEnabled());
  autoUpdater.logger = null;
  try {
    autoUpdater.channel = resolveUpdateChannel();
  } catch {
    // ignore
  }

  wireUpdaterEvents((status) => emitStatus(status));

  // A finished update leaves the old ~2 GB bundle aside rather than spending
  // the restart deleting it. This is where it goes.
  if (process.platform === 'darwin') {
    const macSelfUpdate = require('./macSelfUpdate.cjs');
    const bundlePath = macSelfUpdate.resolveMacBundlePath(
      typeof app.getPath === 'function' ? app.getPath('exe') : process.execPath,
    );
    void macSelfUpdate.sweepStaleBackups(bundlePath).catch(() => {});
  }

  if (readAutoUpdateEnabled()) {
    const initial = setTimeout(() => {
      if (!readAutoUpdateEnabled()) return;
      applyDownloadPreference(true);
      void checkWithFallback();
    }, CHECK_DELAY_MS);
    // Don't keep the process alive for the delayed first check alone.
    if (typeof initial.unref === 'function') initial.unref();

    startRecheckTimer();
  }
}

/**
 * The periodic check, owned in one place because two things turn it on: a
 * launch with the preference already set, and the user setting it during the
 * run. Idempotent — setting the preference twice must not leave two timers
 * checking on their own schedules.
 */
function startRecheckTimer() {
  if (recheckTimer) return;
  recheckTimer = setInterval(() => {
    if (readAutoUpdateEnabled()) {
      applyDownloadPreference(true);
      void checkWithFallback();
    }
  }, RECHECK_INTERVAL_MS);
  if (recheckTimer && typeof recheckTimer.unref === 'function') recheckTimer.unref();
}

function stopRecheckTimer() {
  if (!recheckTimer) return;
  clearInterval(recheckTimer);
  recheckTimer = null;
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
  // Manual download path — keep autoInstall off; allow this call either way.
  isDownloading = true;
  emitStatus({
    state: 'downloading',
    version: lastStatus.version,
    message: '0%',
  });
  return autoUpdater.downloadUpdate();
}

/**
 * Restart and install the downloaded update.
 * macOS unsigned: swap the .app bundle, then relaunch.
 * Windows / Linux AppImage: electron-updater quitAndInstall.
 */
async function quitAndInstall() {
  if (!app.isPackaged) {
    throw new Error('Updates are only available in packaged builds');
  }
  if (lastStatus.state !== 'ready' && !downloadedFile) {
    throw new Error('No downloaded update ready to install');
  }

  if (process.platform === 'darwin') {
    const macSelfUpdate = require('./macSelfUpdate.cjs');
    const bundlePath = macSelfUpdate.resolveMacBundlePath(
      typeof app.getPath === 'function' ? app.getPath('exe') : process.execPath,
    );
    const version = lastStatus.version;

    // Unpacking ~800 MB takes tens of seconds. Say so, and keep saying it —
    // the alternative is a button that spins with the window unable to answer.
    emitStatus({ state: 'installing', version, message: 'preparing' });
    // Whether this process still has the pool and the editor sessions it needs
    // to carry on. Once the preparation has run it does not, whatever happens
    // next.
    const putAway = typeof prepareForInstall === 'function';
    try {
      await prepareForInstall?.();
    } catch (err) {
      console.warn('[MagiesPdf/updater] pre-install cleanup failed:', err?.message || err);
    }

    let installed;
    try {
      installed = await macSelfUpdate.installMacUpdateFromZip({
        zipPath: downloadedFile,
        bundlePath,
        expectedVersion: version ?? null,
        onProgress: (stage) => emitStatus({ state: 'installing', version, message: stage }),
      });
    } catch (cause) {
      if (putAway) {
        // The app was put away before the swap, so this process is a shell: it
        // cannot open a document, run a tool, or save what it was holding, and
        // the window would sit there looking normal. The installed app is
        // intact — a failed swap rolls back — so say what happened and restart
        // into it.
        const message = cause instanceof Error ? cause.message : String(cause);
        try {
          dialog.showErrorBox('Update failed', `${message}\n\nMagies Office will restart.`);
        } catch {
          // No window to attach it to; the restart still has to happen.
        }
        try {
          app.relaunch();
        } catch (err) {
          console.warn('[MagiesPdf/updater] relaunch failed:', err?.message || err);
        }
        app.quit();
      }
      throw cause;
    }
    try {
      app.relaunch({ execPath: installed.executablePath });
    } catch (err) {
      console.warn('[MagiesPdf/updater] relaunch failed:', err?.message || err);
    }
    app.quit();
    return true;
  }

  // isSilent=false, isForceRunAfter=true — relaunch after install.
  autoUpdater.quitAndInstall(false, true);
  return true;
}

async function checkNow(onStatus) {
  if (!app.isPackaged) {
    const status = {
      state: 'current',
      version: app.getVersion(),
      message: 'dev-build',
    };
    onStatus?.(status);
    lastStatus = status;
    return null;
  }
  const checking = { state: 'checking', version: lastStatus.version };
  onStatus?.(checking);
  lastStatus = checking;
  // Manual check should still honour auto-download preference for the follow-up.
  applyDownloadPreference(readAutoUpdateEnabled());
  return checkWithFallback((status) => {
    lastStatus = { ...status };
    onStatus?.(lastStatus);
  });
}

/**
 * Called when Settings → autoUpdate changes.
 * @param {boolean} enabled
 */
function onAutoUpdatePreferenceChanged(enabled) {
  applyDownloadPreference(enabled);
  if (!enabled) {
    stopRecheckTimer();
    return;
  }
  if (app.isPackaged && statusSink) {
    startRecheckTimer();
    void checkWithFallback();
  }
}

module.exports = {
  startUpdater,
  checkWithFallback,
  checkNow,
  downloadUpdate,
  quitAndInstall,
  setInstallPreparation,
  currentFeeds,
  onAutoUpdatePreferenceChanged,
  setAutoDownloadEnabled,
  enforceManualUpdate,
  applyDownloadPreference,
  applyFeed,
  detectPreferredFeed,
  resolveUpdateChannel,
  getLastStatus,
};
