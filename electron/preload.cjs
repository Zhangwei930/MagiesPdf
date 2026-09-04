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
  pickLibreOfficeExecutable: () => ipcRenderer.invoke('office:pickExecutable'),
  openLibreOfficeDownload: () => ipcRenderer.invoke('office:openDownloadPage'),
  pickAndOpenOffice: (multiple) => ipcRenderer.invoke('office:pickAndOpen', { multiple }),
  createAndOpenOffice: (kind) => ipcRenderer.invoke('office:createAndOpen', { kind }),
  openOfficePaths: (paths) => ipcRenderer.invoke('office:openPaths', { paths }),
  createBlankOffice: (kind) => ipcRenderer.invoke('office:createBlank', { kind }),
  openInEditor: (paths, options) =>
    ipcRenderer.invoke('office:editorOpen', {
      paths,
      uiTheme: options && typeof options.uiTheme === 'string' ? options.uiTheme : undefined,
    }),
  /** Starts the editor host and returns static URLs to prefetch into the HTTP cache. */
  warmEditor: () => ipcRenderer.invoke('office:editorWarm'),
  focusEditor: (sessionId) => ipcRenderer.invoke('office:editorFocus', { sessionId }),
  saveEditor: (sessionId, bytes) => ipcRenderer.invoke('office:editorSave', { sessionId, bytes }),
  pickEditorSaveAsTarget: (sessionId, name, kind) =>
    ipcRenderer.invoke('office:editorSaveAsTarget', { sessionId, name, kind }),
  /** Writes the file the engine already produced for "Save copy as". */
  saveEditorExport: (sessionId, name) =>
    ipcRenderer.invoke('office:editorSaveExport', { sessionId, name }),
  closeEditor: (sessionId) => ipcRenderer.invoke('office:editorClose', { sessionId }),
  /** Mirrors the tab's unsaved state so an AI write can refuse to clobber it. */
  /** Names of documents with unsaved changes, so the window can guard its close. */
  reportUnsaved: (names) => ipcRenderer.invoke('app:reportUnsaved', { names }),
  /** The window is closing and asked for everything to be written first. */
  onSaveAllRequested: (handler) => {
    const listener = (_event, payload) => {
      void Promise.resolve(handler())
        .then((result) => ipcRenderer.send('app:saveAllResult', { id: payload.id, ...result }))
        .catch((cause) => ipcRenderer.send('app:saveAllResult', {
          id: payload.id,
          saved: false,
          message: cause instanceof Error ? cause.message : String(cause),
        }));
    };
    ipcRenderer.on('app:saveAllRequested', listener);
    return () => ipcRenderer.off('app:saveAllRequested', listener);
  },
  setEditorModified: (sessionId, modified) =>
    ipcRenderer.invoke('office:editorModified', { sessionId, modified }),
  onEditorSaved: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('office:editorSaved', listener);
    return () => ipcRenderer.off('office:editorSaved', listener);
  },
  /** Fires when a save could not be written; the tab keeps its unsaved state. */
  onEditorSaveFailed: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('office:editorSaveFailed', listener);
    return () => ipcRenderer.off('office:editorSaveFailed', listener);
  },
  /** Editor sessions closed because AI is about to rewrite that path on disk. */
  onOfficeSessionsClosed: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('office:sessionsClosed', listener);
    return () => ipcRenderer.off('office:sessionsClosed', listener);
  },
  /** Disk file updated in place by AI — reopen so the open tab shows the result. */
  onOfficeDocumentApplied: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('office:documentApplied', listener);
    return () => ipcRenderer.off('office:documentApplied', listener);
  },
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

  /** Picks a program to run. Returns its path only — nothing is read. */
  pickExecutable: () => ipcRenderer.invoke('files:pickExecutable'),

  /**
   * Resolves the absolute path of a dropped `File`. `File.path` was removed in
   * Electron 32, and `webUtils` is the supported replacement — it only works in
   * the preload, which is why it is bridged rather than used in the renderer.
   */
  pathForFile: (file) => {
    try {
      const resolved = webUtils.getPathForFile(file);
      // Resolving a real dropped `File` is itself the user action that grants
      // it: a fabricated File resolves to nothing, so a renderer cannot mint a
      // path this way. Registering here is what lets `readFiles` accept it.
      if (resolved) ipcRenderer.send('files:grantDropped', { path: resolved });
      return resolved;
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

  getAiConfig: () => ipcRenderer.invoke('ai:config'),
  setAiApiKey: (apiKey, providerId) => ipcRenderer.invoke('ai:setApiKey', { apiKey, providerId }),
  runAiTurn: (request) => ipcRenderer.invoke('ai:runTurn', request),
  cancelAiTurn: (requestId) => ipcRenderer.invoke('ai:cancelTurn', { requestId }),
  respondAiApproval: (requestId, approvalId, approved) =>
    ipcRenderer.invoke('ai:approvalResponse', { requestId, approvalId, approved }),
  getAiWorkspaceStatus: () => ipcRenderer.invoke('ai:workspaceStatus'),
  pickAiWorkspace: () => ipcRenderer.invoke('ai:pickWorkspace'),
  grantAiWorkspaceForPath: (documentPath) =>
    ipcRenderer.invoke('ai:grantWorkspaceForPath', { path: documentPath }),
  clearAiWorkspace: () => ipcRenderer.invoke('ai:clearWorkspace'),
  getAiHistory: () => ipcRenderer.invoke('ai:historyList'),
  appendAiHistory: (entry) => ipcRenderer.invoke('ai:historyAppend', entry),
  /** Office tool calls from the local API / MCP, waiting for a yes or no. */
  onOfficeToolApproval: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('office:toolApproval', listener);
    return () => ipcRenderer.off('office:toolApproval', listener);
  },
  onOfficeToolApprovalCleared: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('office:toolApprovalCleared', listener);
    return () => ipcRenderer.off('office:toolApprovalCleared', listener);
  },
  respondOfficeToolApproval: (approvalId, decision) =>
    ipcRenderer.invoke('office:toolApprovalResponse', { approvalId, decision }),
  removeAiHistoryEntry: (id) => ipcRenderer.invoke('ai:historyRemove', { id }),
  clearAiHistory: () => ipcRenderer.invoke('ai:historyClear'),
  getAiAutomationState: () => ipcRenderer.invoke('ai:automationState'),
  createAiAutomationRule: (rule) => ipcRenderer.invoke('ai:automationCreate', rule),
  setAiAutomationRuleEnabled: (ruleId, enabled) =>
    ipcRenderer.invoke('ai:automationSetEnabled', { ruleId, enabled }),
  deleteAiAutomationRule: (ruleId) => ipcRenderer.invoke('ai:automationDelete', { ruleId }),
  resolveAiAutomationPending: (pendingId) =>
    ipcRenderer.invoke('ai:automationResolvePending', { pendingId }),
  onAiEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:event', listener);
    return () => ipcRenderer.removeListener('ai:event', listener);
  },
  onAiAutomationEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:automationEvent', listener);
    return () => ipcRenderer.removeListener('ai:automationEvent', listener);
  },

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
  getMcpConfig: () => ipcRenderer.invoke('mcp:config'),
  getWebSearchStatus: () => ipcRenderer.invoke('websearch:status'),
  setWebSearchKey: (apiKey) => ipcRenderer.invoke('websearch:setKey', { apiKey }),
  getImageProviderStatus: () => ipcRenderer.invoke('images:status'),
  setImageProviderKey: (apiKey) => ipcRenderer.invoke('images:setKey', { apiKey }),
  getCliAgents: () => ipcRenderer.invoke('cli:agents'),
  installCliMcp: (agentId) => ipcRenderer.invoke('cli:installMcp', { agentId }),
  getCliModels: (agentId) => ipcRenderer.invoke('cli:models', { agentId }),
  getExternalMcpStatus: () => ipcRenderer.invoke('mcp:externalStatus'),
  setExternalMcpConfig: (config) => ipcRenderer.invoke('mcp:externalSetConfig', { config }),
  refreshExternalMcp: () => ipcRenderer.invoke('mcp:externalRefresh'),
  clearExternalMcpConfig: () => ipcRenderer.invoke('mcp:externalClearConfig'),

  pickDirectory: () => ipcRenderer.invoke('files:pickDirectory'),
  pickFolderFiles: (accept, recursive) =>
    ipcRenderer.invoke('files:pickFolderFiles', { accept, recursive }),

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  printPdf: (bytes, name, pages) => ipcRenderer.invoke('app:printPdf', { bytes, name, pages }),
};

contextBridge.exposeInMainWorld('magiesPdf', api);
