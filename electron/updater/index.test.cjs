/**
 * Dual-link fallback behaviour for the packaged updater (mirrors MagiesTerminal
 * autoUpdateBridge tests for checkForUpdatesWithFallback).
 *
 * electron-updater is stubbed so the suite runs under plain node --test.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const INDEX_PATH = require.resolve('./index.cjs');
const CHANNEL_PATH = require.resolve('./releaseChannel.cjs');

async function withUpdaterMocks(
  {
    checkForUpdates,
    installMacUpdateFromZip,
    appLocale = 'en-US',
    platform = 'darwin',
    isPackaged = true,
    autoUpdate = true,
  } = {},
  fn,
) {
  const feeds = [];
  const listeners = new Map();
  const relaunchCalls = [];
  const errorBoxes = [];
  let quitCalls = 0;
  const fakeAutoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    channel: 'latest',
    logger: null,
    setFeedURL(options) {
      feeds.push({ ...options });
    },
    async checkForUpdates() {
      if (typeof checkForUpdates === 'function') {
        return checkForUpdates(feeds, fakeAutoUpdater);
      }
      return { updateInfo: { version: '1.0.0' } };
    },
    downloadUpdate: async () => true,
    quitAndInstall() {},
    on(event, handler) {
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload);
    },
  };

  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron-updater') {
      return { autoUpdater: fakeAutoUpdater };
    }
    if (request === 'electron') {
      return {
        app: {
          isPackaged,
          getLocale: () => appLocale,
          getVersion: () => '1.0.0',
          getPath: () => '/Applications/MagiesPdf.app/Contents/MacOS/MagiesPdf',
          relaunch(options) {
            relaunchCalls.push(options);
          },
          quit() {
            quitCalls += 1;
          },
        },
        dialog: {
          showErrorBox(title, message) {
            errorBoxes.push({ title, message });
          },
        },
      };
    }
    if (request === '../settings.cjs' && parent?.filename === INDEX_PATH) {
      return {
        read: () => ({ autoUpdate }),
        update: () => ({ autoUpdate }),
      };
    }
    if (
      request === './macSelfUpdate.cjs' &&
      parent?.filename === INDEX_PATH &&
      typeof installMacUpdateFromZip === 'function'
    ) {
      return {
        resolveMacBundlePath: () => '/Applications/MagiesPdf.app',
        installMacUpdateFromZip,
        sweepStaleBackups: async () => 0,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const settingsPath = require.resolve('../settings.cjs');
  delete require.cache[INDEX_PATH];
  delete require.cache[settingsPath];
  // releaseChannel has no electron dep; leave it cached.
  try {
    const updater = require('./index.cjs');
    return await fn({
      errorBoxes,
      updater,
      feeds,
      fakeAutoUpdater,
      listeners,
      platform,
      relaunchCalls,
      getQuitCalls: () => quitCalls,
    });
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, 'platform', originalPlatform);
    delete require.cache[INDEX_PATH];
    delete require.cache[settingsPath];
  }
}

describe('checkWithFallback dual-link', () => {
  it('falls back to the mirror when GitHub is unreachable', async () => {
    await withUpdaterMocks(
      {
        appLocale: 'en-US',
        async checkForUpdates(feeds) {
          const active = feeds.at(-1);
          if (!active || active.provider === 'github') {
            throw new Error('net::ERR_CONNECTION_TIMED_OUT');
          }
          return { updateInfo: { version: '9.9.9' } };
        },
      },
      async ({ updater, feeds }) => {
        const result = await updater.checkWithFallback();
        assert.equal(result.updateInfo.version, '9.9.9');
        assert.equal(feeds.at(-1).provider, 'generic');
        assert.match(feeds.at(-1).url, /dl\.magies\.top\/magiespdf\/stable/);
      },
    );
  });

  it('falls back to GitHub when the mirror fails first (mainland order)', async () => {
    await withUpdaterMocks(
      {
        appLocale: 'zh-CN',
        async checkForUpdates(feeds) {
          const active = feeds.at(-1);
          if (active && active.provider === 'generic') {
            throw new Error('net::ERR_NAME_NOT_RESOLVED');
          }
          return { updateInfo: { version: '9.9.9' } };
        },
      },
      async ({ updater, feeds }) => {
        const result = await updater.checkWithFallback();
        assert.equal(result.updateInfo.version, '9.9.9');
        assert.equal(feeds[0].provider, 'generic');
        assert.equal(feeds.at(-1).provider, 'github');
      },
    );
  });

  it('reports error when both feeds fail', async () => {
    const statuses = [];
    await withUpdaterMocks(
      {
        async checkForUpdates() {
          throw new Error('offline');
        },
      },
      async ({ updater }) => {
        const result = await updater.checkWithFallback((s) => statuses.push(s));
        assert.equal(result, null);
        assert.equal(statuses.at(-1).state, 'error');
        // Summarized dual-feed failure (not the raw electron-updater dump).
        assert.match(statuses.at(-1).message, /github:.*mirror:/);
      },
    );
  });
});

describe('resolveUpdateChannel re-export', () => {
  it('matches releaseChannel for win arm64', async () => {
    await withUpdaterMocks({}, async ({ updater }) => {
      assert.equal(updater.resolveUpdateChannel('win32', 'arm64'), 'latest-arm64');
    });
  });
});

describe('auto-download preference', () => {
  it('enables autoDownload when preference is on; never auto-installs on quit', async () => {
    await withUpdaterMocks({}, async ({ updater, fakeAutoUpdater }) => {
      updater.applyDownloadPreference(true);
      assert.equal(fakeAutoUpdater.autoDownload, true);
      assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, false);

      updater.applyDownloadPreference(false);
      assert.equal(fakeAutoUpdater.autoDownload, false);
      assert.equal(fakeAutoUpdater.autoInstallOnAppQuit, false);
    });
  });

  it('setAutoDownloadEnabled mirrors the preference (not a no-op)', async () => {
    await withUpdaterMocks({}, async ({ updater, fakeAutoUpdater }) => {
      updater.setAutoDownloadEnabled(true);
      assert.equal(fakeAutoUpdater.autoDownload, true);
      updater.setAutoDownloadEnabled(false);
      assert.equal(fakeAutoUpdater.autoDownload, false);
    });
  });
});

describe('status snapshot', () => {
  it('getLastStatus starts idle and tracks emit via startUpdater path', async () => {
    await withUpdaterMocks({}, async ({ updater, fakeAutoUpdater }) => {
      assert.equal(updater.getLastStatus().state, 'idle');
      const statuses = [];
      updater.startUpdater((s) => statuses.push(s));
      // Preference defaults to on → autoDownload true → report downloading.
      fakeAutoUpdater.autoDownload = true;
      fakeAutoUpdater.emit('update-available', { version: '2.0.0' });
      const last = updater.getLastStatus();
      assert.equal(last.state, 'downloading');
      assert.equal(last.version, '2.0.0');
      assert.equal(statuses.at(-1).state, 'downloading');

      fakeAutoUpdater.emit('update-downloaded', {
        version: '2.0.0',
        downloadedFile: '/tmp/MagiesPdf-2.0.0-mac.zip',
      });
      assert.equal(updater.getLastStatus().state, 'ready');
      assert.equal(updater.getLastStatus().version, '2.0.0');
    });
  });

  it('reports available (not downloading) when autoDownload is off', async () => {
    await withUpdaterMocks({}, async ({ updater, fakeAutoUpdater }) => {
      updater.startUpdater(() => {});
      fakeAutoUpdater.autoDownload = false;
      fakeAutoUpdater.emit('update-available', { version: '2.1.0' });
      assert.equal(updater.getLastStatus().state, 'available');
      assert.equal(updater.getLastStatus().version, '2.1.0');
    });
  });
});

describe('macOS client rename during update', () => {
  it('relaunches from the product-named app returned by the installer', async () => {
    const installCalls = [];
    const executablePath = '/Applications/Magies Office.app/Contents/MacOS/Magies Office';

    await withUpdaterMocks(
      {
        async installMacUpdateFromZip(options) {
          installCalls.push(options);
          return {
            bundlePath: '/Applications/Magies Office.app',
            executablePath,
          };
        },
      },
      async ({ updater, fakeAutoUpdater, relaunchCalls, getQuitCalls }) => {
        updater.startUpdater(() => {});
        fakeAutoUpdater.emit('update-downloaded', {
          version: '2.0.0',
          downloadedFile: '/tmp/MagiesPdf-2.0.0-mac.zip',
        });

        await updater.quitAndInstall();

        assert.equal(installCalls.length, 1);
        assert.deepEqual(relaunchCalls, [{ execPath: executablePath }]);
        assert.equal(getQuitCalls(), 1);
      },
    );
  });
});

/**
 * "Restart to install" quits the app and replaces it, so it has to ask about
 * unsaved documents exactly as quitting does — and *before* anything is put
 * away, because the preparation closes every editor session and destroys the
 * worker pool. Answering "cancel" has to leave the app as it was.
 */
describe('installing with unsaved documents open', () => {
  it('does not install when the preparation says not to', async () => {
    let installs = 0;
    await withUpdaterMocks(
      {
        installMacUpdateFromZip: async () => {
          installs += 1;
          return { bundlePath: '/x.app', executablePath: '/x.app/Contents/MacOS/x' };
        },
      },
      async ({ updater, fakeAutoUpdater, relaunchCalls, getQuitCalls }) => {
        updater.setInstallPreparation(async () => false);
        updater.startUpdater(() => {});
        fakeAutoUpdater.emit('update-downloaded', {
          version: '2.0.0',
          downloadedFile: '/tmp/x.zip',
        });

        assert.equal(await updater.quitAndInstall(), false);
        assert.equal(installs, 0, 'nothing may be swapped');
        assert.deepEqual(relaunchCalls, []);
        assert.equal(getQuitCalls(), 0, 'and the app stays');
      },
    );
  });

  it('leaves the update ready to install again', async () => {
    await withUpdaterMocks(
      { installMacUpdateFromZip: async () => ({ bundlePath: '/x.app', executablePath: '/x' }) },
      async ({ updater, fakeAutoUpdater }) => {
        const seen = [];
        updater.setInstallPreparation(async () => false);
        updater.startUpdater((status) => seen.push(status.state));
        fakeAutoUpdater.emit('update-downloaded', { version: '2.0.0', downloadedFile: '/tmp/x.zip' });

        await updater.quitAndInstall();

        assert.equal(seen.at(-1), 'ready', 'the toast goes back to offering the install');
      },
    );
  });

  it('installs when the preparation says go ahead', async () => {
    let installs = 0;
    await withUpdaterMocks(
      {
        installMacUpdateFromZip: async () => {
          installs += 1;
          return { bundlePath: '/x.app', executablePath: '/x.app/Contents/MacOS/x' };
        },
      },
      async ({ updater, fakeAutoUpdater, getQuitCalls }) => {
        updater.setInstallPreparation(async () => true);
        updater.startUpdater(() => {});
        fakeAutoUpdater.emit('update-downloaded', { version: '2.0.0', downloadedFile: '/tmp/x.zip' });

        assert.equal(await updater.quitAndInstall(), true);
        assert.equal(installs, 1);
        assert.equal(getQuitCalls(), 1);
      },
    );
  });
});

/**
 * The macOS install puts the app away before it swaps the bundle — the worker
 * pool and the editor host read files out of the .app that is about to be
 * renamed. If the swap then fails, this process is a shell: it cannot open a
 * document, run a tool, or save what it is holding, and the window would sit
 * there looking normal.
 *
 * The installed app is intact, because a failed swap rolls back. So the honest
 * answer is to say what happened and restart into it.
 */
describe('an install that fails after the app has been put away', () => {
  it('says why and restarts rather than leaving a window that cannot work', async () => {
    await withUpdaterMocks(
      {
        installMacUpdateFromZip: async () => {
          throw new Error('the destination is not writable');
        },
      },
      async ({ updater, fakeAutoUpdater, relaunchCalls, getQuitCalls, errorBoxes }) => {
        let prepared = false;
        updater.setInstallPreparation(async () => {
          prepared = true;
        });
        updater.startUpdater(() => {});
        fakeAutoUpdater.emit('update-downloaded', {
          version: '2.0.0',
          downloadedFile: '/tmp/MagiesPdf-2.0.0-mac.zip',
        });

        await assert.rejects(() => updater.quitAndInstall(), /not writable/);

        assert.equal(prepared, true, 'the app was put away first');
        assert.equal(errorBoxes.length, 1, 'the user is told why');
        assert.match(errorBoxes[0].message, /not writable/);
        assert.equal(relaunchCalls.length, 1, 'and restarted into the app that is still there');
        assert.equal(getQuitCalls(), 1);
      },
    );
  });

  /** Nothing was put away, so there is nothing to recover from. */
  it('leaves the app alone when it never got that far', async () => {
    await withUpdaterMocks(
      {
        installMacUpdateFromZip: async () => {
          throw new Error('no downloaded update');
        },
      },
      async ({ updater, fakeAutoUpdater, relaunchCalls, getQuitCalls, errorBoxes }) => {
        updater.setInstallPreparation(null);
        updater.startUpdater(() => {});
        fakeAutoUpdater.emit('update-downloaded', {
          version: '2.0.0',
          downloadedFile: '/tmp/MagiesPdf-2.0.0-mac.zip',
        });

        await assert.rejects(() => updater.quitAndInstall());

        assert.deepEqual(errorBoxes, []);
        assert.deepEqual(relaunchCalls, []);
        assert.equal(getQuitCalls(), 0);
      },
    );
  });
});

// Ensure the dual-link module graph still resolves from disk after mocks.
describe('releaseChannel module path', () => {
  it('lives beside index', () => {
    assert.equal(path.dirname(CHANNEL_PATH), path.dirname(INDEX_PATH));
  });
});

/**
 * The six-hour recheck was created only inside the `startUpdater` branch that
 * runs when auto-update is already on. Turning it on later checked once and
 * then never again for the rest of the run. See issue #32.
 */
describe('auto-update preference and the recheck timer', () => {
  function withIntervalSpy(fn) {
    const realSet = global.setInterval;
    const realClear = global.clearInterval;
    const live = new Set();
    global.setInterval = () => {
      const handle = { unref: () => handle };
      live.add(handle);
      return handle;
    };
    global.clearInterval = (handle) => {
      live.delete(handle);
    };
    try {
      return fn(() => live.size);
    } finally {
      global.setInterval = realSet;
      global.clearInterval = realClear;
    }
  }

  it('starts the recheck when the preference is turned on during a run', async () => {
    await withUpdaterMocks({ autoUpdate: false }, async ({ updater }) => {
      await withIntervalSpy(async (liveTimers) => {
        updater.startUpdater(() => {});
        assert.equal(liveTimers(), 0, 'nothing periodic while the preference is off');

        updater.onAutoUpdatePreferenceChanged(true);
        assert.equal(liveTimers(), 1, 'turning it on starts the recheck');
      });
    });
  });

  it('stops the recheck when the preference is turned off', async () => {
    await withUpdaterMocks({ autoUpdate: true }, async ({ updater }) => {
      await withIntervalSpy(async (liveTimers) => {
        updater.startUpdater(() => {});
        assert.equal(liveTimers(), 1);

        updater.onAutoUpdatePreferenceChanged(false);
        assert.equal(liveTimers(), 0);
      });
    });
  });

  it('does not stack timers when the same preference is set twice', async () => {
    await withUpdaterMocks({ autoUpdate: false }, async ({ updater }) => {
      await withIntervalSpy(async (liveTimers) => {
        updater.startUpdater(() => {});
        updater.onAutoUpdatePreferenceChanged(true);
        updater.onAutoUpdatePreferenceChanged(true);
        assert.equal(liveTimers(), 1);

        updater.onAutoUpdatePreferenceChanged(false);
        updater.onAutoUpdatePreferenceChanged(false);
        assert.equal(liveTimers(), 0);
      });
    });
  });
});
