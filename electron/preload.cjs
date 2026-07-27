const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('node:path');

/**
 * The renderer's entire view of the outside world.
 *
 * Context isolation is on and node integration is off, so this is the only
 * surface the UI can reach. Every entry is an explicit, narrow operation —
 * there is deliberately no generic "invoke any channel" escape hatch.
 */

/** Same field electron-builder / app.getVersion() use — keep UI in lockstep. */
function resolveAppVersion() {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    return require(path.join(__dirname, '..', 'package.json')).version;
  } catch {
    return '1.0.0';
  }
}

const api = {
  platform: process.platform,
  /** Prefer the packaged app version; fall back for plain `electron .` in dev. */
  version: resolveAppVersion(),

  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  isPackaged: () => ipcRenderer.invoke('app:isPackaged'),

  /** Tool metadata for the UI. Implementations stay in the worker pool. */
  getCatalog: () => ipcRenderer.invoke('catalog:get'),

  /** Opens the system file picker. Returns [] when the user cancels. */
  pickFiles: (accept, multiple) => ipcRenderer.invoke('files:pick', { accept, multiple }),

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

  revealPath: (target) => ipcRenderer.invoke('shell:reveal', { path: target }),

  runJob: (request) => ipcRenderer.invoke('job:run', request),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', { jobId }),

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
