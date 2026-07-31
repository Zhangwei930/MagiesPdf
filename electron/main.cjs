const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, app, nativeTheme, shell } = require('electron');
const { JobPool } = require('./jobs/pool.cjs');
const { documentPathsFromArgv, openableDocumentPath } = require('./files/openPaths.cjs');
const { registerIpc } = require('./ipc.cjs');
const settings = require('./settings.cjs');
const { startUpdater } = require('./updater/index.cjs');
const { syncApiServer, stopApiServer } = require('./api/server.cjs');
const { MAIN_WINDOW_WEB_PREFERENCES, isTrustedRendererUrl } = require('./security.cjs');

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

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {JobPool | null} */
let pool = null;

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

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
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
    try {
      if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    } catch {
      // Invalid URLs are denied below.
    }
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

  window.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  return window;
}

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
    registerIpc({
      pool,
      getWindow: () => mainWindow,
      trustedRendererUrl: RENDERER_URL,
      onSettingsChanged: () => {
        void syncApiServer({ pool }).catch((error) => {
          console.error('[magiespdf] REST API failed to start:', error.message);
        });
      },
    });
    mainWindow = createWindow();

    // Windows and Linux deliver a double-clicked document in argv.
    requestOpen(documentPathsFromArgv(process.argv, { isPackaged: app.isPackaged }));

    // Honour a previously-enabled API setting from the last session.
    void syncApiServer({ pool }).catch((error) => {
      console.error('[magiespdf] REST API failed to start:', error.message);
    });

    // Overseas installs check GitHub, mainland ones the mirror. When autoUpdate
    // is on we check + download automatically; install still needs a click.
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

  app.on('before-quit', () => {
    void stopApiServer();
    void pool?.destroy();
  });
}
