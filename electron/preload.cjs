const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * The renderer's entire view of the outside world.
 *
 * Context isolation is on and node integration is off, so this is the only
 * surface the UI can reach. Every entry is an explicit, narrow operation —
 * there is deliberately no generic "invoke any channel" escape hatch.
 */

/** Same field electron-builder / app.getVersion() use — keep UI in lockstep. */
function resolveAppVersion() {
  return process.env.npm_package_version || '1.0.2';
}

const api = {
  platform: process.platform,
  /** Prefer the packaged app version; fall back for plain `electron .` in dev. */
  version: resolveAppVersion(),

  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  isPackaged: () => ipcRenderer.invoke('app:isPackaged'),

  /** Tool metadata for the UI. Implementations stay in the worker pool. */
  getCatalog: () => ipcRenderer.invoke('catalog:get'),

  getOfficeStatus: () => ipcRenderer.invoke('office:status'),
  pickAndOpenOffice: (multiple) => ipcRenderer.invoke('office:pickAndOpen', { multiple }),
  createAndOpenOffice: (kind) => ipcRenderer.invoke('office:createAndOpen', { kind }),
  openOfficePaths: (paths) => ipcRenderer.invoke('office:openPaths', { paths }),
  listRecentDocuments: () => ipcRenderer.invoke('office:listRecent'),
  renameRecentDocument: (target, name) =>
    ipcRenderer.invoke('office:renameRecent', { path: target, name }),
  trashRecentDocument: (target) => ipcRenderer.invoke('office:trashRecent', { path: target }),
  forgetRecentDocument: (target) => ipcRenderer.invoke('office:forgetRecent', { path: target }),

  /** Opens the system file picker. Returns [] when the user cancels. */
  pickFiles: (accept, multiple) => ipcRenderer.invoke('files:pick', { accept, multiple }),
  pickDocumentPaths: (multiple) => ipcRenderer.invoke('files:pickDocumentPaths', { multiple }),

  /** Reads files the user dropped onto the window, by absolute path. */
  readFiles: (paths) => ipcRenderer.invoke('files:read', { paths }),

  /**
   * Resolves the absolute path of a dropped `File`. `File.path` was removed in
   * Electron 32, and `webUtils` is the supported replacement — it only works in
   * the preload, which is why it is bridged rather than used in the renderer.
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  /** Writes outputs to a directory the user chooses. Returns null when cancelled. */
  saveOutputs: (files, options) => ipcRenderer.invoke('files:save', { files, options }),

  /** Writes a single output through a "save as" dialog. */
  saveOutputAs: (file) => ipcRenderer.invoke('files:saveAs', { file }),

  /**
   * Overwrites a file already open in the app — ⌘S. Only paths this process
   * handed over are accepted; see `files/writableTargets.cjs`.
   */
  writeToPath: (targetPath, bytes) =>
    ipcRenderer.invoke('files:writeTo', { path: targetPath, bytes }),

  revealPath: (target) => ipcRenderer.invoke('shell:reveal', { path: target }),

  runJob: (request) => ipcRenderer.invoke('job:run', request),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', { jobId }),

  /**
   * Subscribes to documents the OS asked the app to open — a double-click, an
   * Open With, or a second launch. Only paths cross; the renderer reads them
   * back through `readFiles`, which is where size and type are enforced.
   * Returns an unsubscribe function.
   */
  onOpenFiles: (callback) => {
    const listener = (_event, payload) => callback(payload?.paths ?? []);
    ipcRenderer.on('app:openFiles', listener);
    return () => ipcRenderer.removeListener('app:openFiles', listener);
  },

  /** Subscribes to progress for all jobs. Returns an unsubscribe function. */
  onJobProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },

  /** Subscribes to update-check status. Returns an unsubscribe function. */
  onUpdaterStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  /** Latest known updater status (hydrates Settings / toast after late mount). */
  getUpdaterStatus: () => ipcRenderer.invoke('updater:status'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getApiStatus: () => ipcRenderer.invoke('api:status'),

  pickDirectory: () => ipcRenderer.invoke('files:pickDirectory'),
  pickFolderFiles: (accept, recursive) =>
    ipcRenderer.invoke('files:pickFolderFiles', { accept, recursive }),
};

contextBridge.exposeInMainWorld('magiesPdf', api);
