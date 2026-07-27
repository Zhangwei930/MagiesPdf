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

async function withUpdaterMocks({ checkForUpdates, appLocale = 'en-US' } = {}, fn) {
  const feeds = [];
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
    on() {},
  };

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron-updater') {
      return { autoUpdater: fakeAutoUpdater };
    }
    if (request === 'electron') {
      return {
        app: {
          isPackaged: true,
          getLocale: () => appLocale,
          getVersion: () => '1.0.0',
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[INDEX_PATH];
  // releaseChannel has no electron dep; leave it cached.
  try {
    const updater = require('./index.cjs');
    return await fn({ updater, feeds, fakeAutoUpdater });
  } finally {
    Module._load = originalLoad;
    delete require.cache[INDEX_PATH];
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
        assert.match(statuses.at(-1).message, /All update feeds failed/);
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

// Ensure the dual-link module graph still resolves from disk after mocks.
describe('releaseChannel module path', () => {
  it('lives beside index', () => {
    assert.equal(path.dirname(CHANNEL_PATH), path.dirname(INDEX_PATH));
  });
});
