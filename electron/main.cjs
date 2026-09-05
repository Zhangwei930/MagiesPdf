const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { JobPool } = require('./jobs/pool.cjs');
const { documentPathsFromArgv, openableDocumentPath } = require('./files/openPaths.cjs');
const readableTargets = require('./files/readableTargets.cjs');
const { registerIpc } = require('./ipc.cjs');
const settings = require('./settings.cjs');
const { startUpdater, setInstallPreparation } = require('./updater/index.cjs');
const { createShutdownSequence } = require('./shutdown.cjs');
const { syncApiServer, stopApiServer } = require('./api/server.cjs');
const { createApprovalGate } = require('./api/approvalGate.cjs');
const {
  createCloseGuard,
  createQuitPrompt,
  createSaveAllRequester,
} = require('./closeGuard.cjs');
const { createQuitCleanup } = require('./quitCleanup.cjs');
const {
  MAIN_WINDOW_WEB_PREFERENCES,
  isExternalUrlAllowed,
  isTrustedRendererUrl,
} = require('./security.cjs');

/**
 * MagiesPdf main process.
 *
 * Responsibilities are deliberately thin: own the window, own the worker pool,
 * and expose a narrow IPC surface. All PDF work happens in `src/core`, running
 * inside the pool's worker threads.
 */

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);
const PACKAGED_INDEX_PATH = path.join(__dirname, '..', 'dist', 'index.html');
const RENDERER_URL = isDev ? new URL(DEV_SERVER_URL).href : pathToFileURL(PACKAGED_INDEX_PATH).href;

// The visible product name changed, but existing settings and recent documents
// must remain in the directory used by every previous MagiesPdf release.
settings.preserveLegacyUserDataPath(app);

/**
 * What the renderer last reported as unsaved. Held here rather than asked for
 * at close time: `close` is synchronous, and a round trip cannot be awaited
 * inside it.
 */
let unsavedNames = [];

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {JobPool | null} */
let pool = null;
let ipcServices = null;

/**
 * Office tools reached over the local REST API (which is how the magies-office
 * MCP server talks to this app) ask here in "confirm" mode. Without it a CLI
 * agent holding the API token would edit documents with no in-app question,
 * which is the one thing the permission mode is supposed to prevent.
 */
const restApprovals = createApprovalGate({
  // The question is drawn in the AI panel, next to the work it is about — see
  // electron/api/rendererApprovalPrompt.cjs. Before the window exists there is
  // nobody to ask, and the gate's own answer for that is no.
  prompt: (request) => ipcServices?.requestToolApproval?.(request) ?? Promise.resolve('deny'),
});

/**
 * Documents asked for before the renderer could receive them.
 *
 * Double-clicking a PDF *starts* the app, so the request always arrives before
 * there is a window — and on macOS `open-file` can even fire before `ready`.
 * Queue until the renderer says it is listening, then hand the batch over.
 *
 * @type {string[]}
 */
let pendingOpenPaths = [];
let rendererReady = false;

/** Hands paths to the renderer, or holds them until there is one. */
function requestOpen(paths) {
  if (paths.length === 0) return;
  // The OS handed these over — argv, "Open With", a drop on the dock icon. The
  // renderer will ask to read them next, and this is what lets it.
  readableTargets.grantAll(paths);
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) {
    for (const target of paths) {
      if (!pendingOpenPaths.includes(target)) pendingOpenPaths.push(target);
    }
    return;
  }
  mainWindow.webContents.send('app:openFiles', { paths });
}

function flushPendingOpens() {
  const paths = pendingOpenPaths;
  pendingOpenPaths = [];
  requestOpen(paths);
}

/** The window background shown before first paint. */
function resolveBackgroundColor() {
  const { theme } = settings.read();
  const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark';
  return dark ? '#0e1116' : '#f6f7f9';
}

const saveAll = createSaveAllRequester({
  getContents: () => {
    const contents = mainWindow?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  },
  send: (contents, payload) => contents.send('app:saveAllRequested', payload),
});

const closeGuard = createCloseGuard({
  unsavedDocuments: () => unsavedNames,
  ask: createQuitPrompt({ dialog, getWindow: () => mainWindow }),
  saveAll: () => saveAll.saveAll(),
});

/**
 * `before-quit` cannot be awaited, so the first attempt is refused, the
 * cleanup runs, and the quit is asked for again. Read lazily: quitting can
 * happen before any of these exist.
 */
const quitCleanup = createQuitCleanup({
  steps: [
    () => stopApiServer(),
    () => ipcServices?.close() ?? Promise.resolve(),
    () => pool?.destroy() ?? Promise.resolve(),
  ],
  quit: () => app.quit(),
});

/**
 * Asking comes before putting away. See `shutdown.cjs`: the cleanup used to
 * run from `before-quit`, ahead of the unsaved prompt, so a cancelled quit
 * left an app whose worker pool and editor sessions were already gone.
 */
const shutdown = createShutdownSequence({
  mayClose: () => closeGuard.mayClose(),
  holdQuit: () => quitCleanup.holdQuit(),
  quit: () => app.quit(),
});

ipcMain.handle('app:reportUnsaved', (_event, payload) => {
  const names = Array.isArray(payload?.names) ? payload.names : [];
  unsavedNames = names.filter((name) => typeof name === 'string' && name !== '');
  return true;
});

ipcMain.on('app:saveAllResult', (_event, payload) => saveAll.settle(payload));

function createWindow() {
  const window = new BrowserWindow({
    // An editor's ribbon, the document, and a rail on either side all have to
    // fit at once — an office suite opened at a browser's default size makes
    // every one of them cramped.
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: 'Magies Office',
    // Dock / taskbar icon (Windows & Linux; macOS uses the .icns in the bundle).
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // Painted before the renderer has any CSS, so it must match the theme the
    // app will actually resolve to — including following the OS for "system".
    backgroundColor: resolveBackgroundColor(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      ...MAIN_WINDOW_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Avoid the white flash before React has painted.
  window.once('ready-to-show', () => window.show());

  if (isDev) {
    void window.loadURL(RENDERER_URL);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(PACKAGED_INDEX_PATH);
  }

  // Documents are local; nothing in the UI should ever navigate or open a window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrlAllowed(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, RENDERER_URL)) event.preventDefault();
  });

  // A renderer that fails to boot shows an empty window and nothing else — the
  // console lives in a process whose output is otherwise invisible from a
  // terminal. Forwarding it makes `npm run dev` and a packaged-app smoke test
  // diagnosable instead of a guessing game.
  if (isDev || process.env.MAGIESPDF_DEBUG === '1') {
    window.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    window.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`[renderer] failed to load ${url}: ${code} ${description}`);
    });
  }

  // Anything queued while the app was starting can go over now.
  window.webContents.on('did-finish-load', () => {
    rendererReady = true;
    flushPendingOpens();
  });

  // Closing a tab asked about unsaved changes; closing the window did not.
  // The close button, ⌘Q and Alt+F4 all went straight through. `close` has to
  // be answered synchronously, so the decision is taken afterwards and the
  // window closed again once it is made.
  // A window opened now is holding no documents anyone has been asked about.
  shutdown.reset();
  window.on('close', (event) => {
    // Shared with the quit: ⌘Q asks, approves, and then closes the window, and
    // being asked a second time on the way out is not a question.
    if (shutdown.isApproved()) return;
    event.preventDefault();
    void closeGuard
      .mayClose()
      .then((mayClose) => {
        if (!mayClose) return;
        shutdown.approveClose();
        window.close();
      })
      .catch(() => {
        // Deciding failed; the window stays, which is the safe direction.
      });
  });

  window.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  return window;
}

// The embedded editor's font scheme has to be declared before the app is ready,
// or it will not resolve relative urls or be allowed past the page's CSP.

// A second instance would fight over the settings file and the API port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Double-clicking a document while the app is already running lands here
  // rather than starting a second copy.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    requestOpen(documentPathsFromArgv(argv, { isPackaged: app.isPackaged, cwd: workingDirectory }));
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // macOS never puts documents in argv: Open With, a double-click and a drop on
  // the dock icon all arrive here, and can fire before the app is ready.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    const target = openableDocumentPath(filePath);
    if (target !== '') requestOpen([target]);
  });

  app.whenReady().then(() => {
    pool = new JobPool();
    ipcServices = registerIpc({
      pool,
      getWindow: () => mainWindow,
      trustedRendererUrl: RENDERER_URL,
      onSettingsChanged: () => {
        // Changing the permission mode (or the token) starts a fresh run:
        // tools allowed "for this run" have to be asked about again.
        restApprovals.reset();
        void syncApiServer({
          pool,
          officeProvider: ipcServices?.officeAutomation ?? null,
          requestApproval: restApprovals.request,
        }).catch((error) => {
          console.error('[magiespdf] REST API failed to start:', error.message);
        });
      },
    });
    mainWindow = createWindow();

    // Windows and Linux deliver a double-clicked document in argv.
    requestOpen(documentPathsFromArgv(process.argv, { isPackaged: app.isPackaged }));

    // Honour a previously-enabled API setting from the last session.
    // Office automation is the same provider the built-in AI uses.
    void syncApiServer({
      pool,
      officeProvider: ipcServices?.officeAutomation ?? null,
      requestApproval: restApprovals.request,
    }).catch((error) => {
      console.error('[magiespdf] REST API failed to start:', error.message);
    });

    // Overseas installs check GitHub, mainland ones the mirror. When autoUpdate
    // is on we check + download automatically; install still needs a click.
    // Installing quits the app and replaces it, so it asks about unsaved
    // documents exactly as quitting does — and asks *first*, because putting
    // things away closes every editor session and destroys the worker pool.
    // Only then the teardown: on macOS the install renames the .app this
    // process runs from, and the pool and the editor host read files out of
    // it, so doing this during the quit is too late.
    setInstallPreparation(async () => {
      if (!(await closeGuard.mayClose())) return false;
      // The quit that follows must not ask the same question again.
      shutdown.approveClose();
      await quitCleanup.release();
      return true;
    });

    startUpdater((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', status);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (shutdown.requestQuit()) event.preventDefault();
  });
}
