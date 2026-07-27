const path = require('node:path');
const { BrowserWindow, app, nativeTheme, shell } = require('electron');
const { JobPool } = require('./jobs/pool.cjs');
const { registerIpc } = require('./ipc.cjs');
const settings = require('./settings.cjs');
const { startUpdater } = require('./updater/index.cjs');
const { syncApiServer, stopApiServer } = require('./api/server.cjs');

/**
 * MagiesPdf main process.
 *
 * Responsibilities are deliberately thin: own the window, own the worker pool,
 * and expose a narrow IPC surface. All PDF work happens in `src/core`, running
 * inside the pool's worker threads.
 */

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {JobPool | null} */
let pool = null;

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
    title: 'MagiesPdf',
    // Dock / taskbar icon (Windows & Linux; macOS uses the .icns in the bundle).
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // Painted before the renderer has any CSS, so it must match the theme the
    // app will actually resolve to — including following the OS for "system".
    backgroundColor: resolveBackgroundColor(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // Avoid the white flash before React has painted.
  window.once('ready-to-show', () => window.show());

  if (isDev) {
    void window.loadURL(DEV_SERVER_URL);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    void window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Documents are local; nothing in the UI should ever navigate or open a window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isDev || !url.startsWith(DEV_SERVER_URL)) event.preventDefault();
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

  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

// A second instance would fight over the settings file and the API port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    pool = new JobPool();
    registerIpc({
      pool,
      getWindow: () => mainWindow,
      onSettingsChanged: () => {
        void syncApiServer({ pool }).catch((error) => {
          console.error('[magiespdf] REST API failed to start:', error.message);
        });
      },
    });
    mainWindow = createWindow();

    // Honour a previously-enabled API setting from the last session.
    void syncApiServer({ pool }).catch((error) => {
      console.error('[magiespdf] REST API failed to start:', error.message);
    });

    // Overseas installs check GitHub, mainland ones the mirror; either way the
    // user is only notified, never updated behind their back.
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
