const fs = require('node:fs/promises');
const path = require('node:path');
const { app, dialog, ipcMain, shell } = require('electron');
const settings = require('./settings.cjs');
const mainRunner = require('./jobs/mainRunner.cjs');
const { createJobExecutor } = require('./jobs/executor.cjs');
const { createHostBridge } = require('./host.cjs');
const { collectFilePaths } = require('./files/walk.cjs');
const { InputBudget } = require('./files/inputBudget.cjs');
const writableTargets = require('./files/writableTargets.cjs');
const updater = require('./updater/index.cjs');
const { isTrustedIpcSender, safeFileName } = require('./security.cjs');
const { createOfficeService } = require('./office/service.cjs');
const { DOCUMENT_EXTENSIONS } = require('./office/formats.cjs');
const { createAiService } = require('./ai/service.cjs');
const { getSecretStore } = require('./ai/secrets.cjs');
const { buildMcpClientConfig } = require('./mcp/config.cjs');
const { createExternalMcpClientManager } = require('./mcp/clientManager.cjs');

/**
 * IPC handlers. Every one of these is a boundary between untrusted renderer
 * input and the file system, so paths and sizes are checked here rather than
 * assumed to be sane.
 */

/** Refuse to slurp anything that cannot plausibly be a document we can process. */
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 1024 * 1024 * 1024;
const MAX_INPUT_FILES = 200;

const MIME_BY_EXTENSION = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeOf(name) {
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

async function readOne(absolutePath, budget) {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${absolutePath}`);
  budget.add(stat.size);

  const buffer = await fs.readFile(absolutePath);
  // Handing the contents to the renderer is what earns this path the right to
  // be overwritten later by an in-place save.
  writableTargets.remember(absolutePath);
  return {
    name: path.basename(absolutePath),
    path: absolutePath,
    size: stat.size,
    mime: mimeOf(absolutePath),
    // A Buffer is a Uint8Array view; copy into a standalone one so the whole
    // pooled Buffer slab is not shipped across the IPC boundary.
    bytes: new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length)),
  };
}

async function readMany(paths) {
  const budget = new InputBudget({
    maxFileBytes: MAX_INPUT_BYTES,
    maxTotalBytes: MAX_TOTAL_INPUT_BYTES,
    maxFiles: MAX_INPUT_FILES,
  });
  const files = [];
  for (const absolutePath of paths) files.push(await readOne(absolutePath, budget));
  return files;
}

/** `report.pdf` → `report (2).pdf` until the name is free. */
async function freeName(directory, name) {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);

  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${stem} (${n})${extension}`;
    try {
      await fs.access(path.join(directory, candidate));
    } catch {
      return candidate;
    }
  }
}

/**
 * Tool metadata, emitted at build time by `scripts/generate-catalog.mjs`.
 * Read once and cached — it cannot change while the app is running.
 */
let catalogCache = null;

function readCatalog() {
  if (catalogCache) return catalogCache;
  const catalogPath = path.join(__dirname, '..', 'dist-electron', 'catalog.json');
  catalogCache = JSON.parse(require('node:fs').readFileSync(catalogPath, 'utf8'));
  return catalogCache;
}

function registerIpc({ pool, getWindow, onSettingsChanged, trustedRendererUrl }) {
  const office = createOfficeService();
  const handle = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event, getWindow(), trustedRendererUrl)) {
        throw new Error(`Rejected untrusted IPC request: ${channel}`);
      }
      return handler(event, ...args);
    });
  };

  handle('catalog:get', () => readCatalog().tools);

  handle('office:status', () => office.status());
  handle('office:pickExecutable', () => office.pickExecutable(getWindow()));
  handle('office:openDownloadPage', () => office.openDownloadPage());
  handle('office:pickAndOpen', (_event, { multiple }) =>
    office.pickAndOpen(getWindow(), multiple === true),
  );
  handle('office:createAndOpen', (_event, { kind }) =>
    office.createAndOpen(getWindow(), kind),
  );
  handle('office:openPaths', (_event, { paths }) =>
    office.openPaths(Array.isArray(paths) ? paths : []),
  );
  handle('office:listRecent', () => office.listRecent());
  handle('office:renameRecent', (_event, { path: target, name }) =>
    office.renameRecent(target, name),
  );
  handle('office:trashRecent', (_event, { path: target }) => office.trashRecent(target));
  handle('office:forgetRecent', (_event, { path: target }) => office.forgetRecent(target));

  handle('files:pick', async (_event, { accept, multiple }) => {
    const extensions = (accept ?? ['.pdf']).map((e) => e.replace(/^\./, ''));
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: extensions.join('/').toUpperCase(), extensions },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (result.canceled) return [];
    return readMany(result.filePaths);
  });

  handle('files:pickDocumentPaths', async (_event, { multiple }) => {
    const extensions = [...DOCUMENT_EXTENSIONS].map((extension) => extension.slice(1));
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Documents', extensions }],
    });
    return result.canceled ? [] : result.filePaths;
  });

  handle('files:read', async (_event, { paths }) => {
    if (!Array.isArray(paths)) return [];
    const targets = paths.filter((p) => typeof p === 'string' && p !== '');
    const files = await readMany(targets);
    office.rememberRecent(targets);
    return files;
  });

  handle('files:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? '' : (result.filePaths[0] ?? '');
  });

  /**
   * Pick a folder and load matching files (optionally recursive) for batch work.
   * Caps at 200 files so a mistaken root directory cannot freeze the app.
   */
  handle('files:pickFolderFiles', async (_event, { accept, recursive }) => {
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { directory: '', files: [], truncated: false };
    }

    const directory = result.filePaths[0];
    const paths = await collectFilePaths(directory, {
      accept: accept ?? ['.pdf'],
      recursive: recursive !== false,
      maxFiles: 200,
    });
    // maxFiles is a hard stop inside the walker; if we hit exactly 200 there
    // may be more on disk — surface that so the UI can warn.
    const truncated = paths.length >= 200;
    const files = await readMany(paths);
    return { directory, files, truncated };
  });

  handle('files:save', async (_event, { files, options }) => {
    if (!Array.isArray(files) || files.length === 0) return null;

    let directory = options?.directory || settings.read().defaultOutputDirectory;
    if (!directory) {
      const result = await dialog.showOpenDialog(getWindow(), {
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Save here',
      });
      if (result.canceled) return null;
      directory = result.filePaths[0];
    }

    await fs.mkdir(directory, { recursive: true });
    const overwrite = settings.read().onNameCollision === 'overwrite';

    const written = [];
    for (const file of files) {
      const safeName = safeFileName(file.name);
      const name = overwrite ? safeName : await freeName(directory, safeName);
      const target = path.join(directory, name);
      await fs.writeFile(target, Buffer.from(file.bytes));
      written.push(target);
    }

    writableTargets.rememberAll(written);
    return { directory, written };
  });

  handle('files:saveAs', async (_event, { file }) => {
    const result = await dialog.showSaveDialog(getWindow(), { defaultPath: safeFileName(file.name) });
    if (result.canceled || !result.filePath) return null;

    await fs.writeFile(result.filePath, Buffer.from(file.bytes));
    // The user picked this destination, so a later ⌘S may write over it.
    writableTargets.remember(result.filePath);
    return { written: [result.filePath], directory: path.dirname(result.filePath) };
  });

  /**
   * Overwrite a file the app already holds — what ⌘S means in every editor.
   *
   * The path is not merely validated but *authorised*: only files whose
   * contents this process itself gave the renderer can be written back. A path
   * the renderer invented, however well formed, is refused.
   */
  handle('files:writeTo', async (_event, { path: target, bytes }) => {
    if (!writableTargets.isWritable(target)) {
      throw new Error('Refused to overwrite a file this app did not open');
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('Refused to write a non-binary payload');
    }

    await fs.writeFile(target, Buffer.from(bytes));
    return { written: [target], directory: path.dirname(target) };
  });

  handle('shell:reveal', (_event, { path: target }) => {
    if (typeof target === 'string' && target !== '') shell.showItemInFolder(target);
    return true;
  });

  const hostBridge = createHostBridge();
  const secretStore = getSecretStore();
  const externalMcpManager = createExternalMcpClientManager({
    secretStore,
    version: app.getVersion(),
  });
  const jobExecutor = createJobExecutor({
    tools: readCatalog().tools,
    pool,
    mainRunner,
    hostBridge,
  });
  const aiService = createAiService({
    readCatalog,
    readSettings: settings.read,
    secretStore,
    externalToolProvider: externalMcpManager,
    executeTool: ({ signal, onProgress, ...request }) =>
      jobExecutor.run(request, onProgress, signal),
  });

  handle('job:run', async (event, request) => {
    const onProgress = (fraction, message) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send('job:progress', { jobId: request.jobId, fraction, message });
    };

    return jobExecutor.run(request, onProgress);
  });

  handle('job:cancel', (_event, { jobId }) => jobExecutor.cancel(jobId));

  handle('ai:config', () => aiService.getConfig());
  handle('ai:setApiKey', (_event, { apiKey }) => aiService.setApiKey(apiKey));
  handle('ai:runTurn', (event, request) =>
    aiService.runTurn(request, (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:event', payload);
    }),
  );
  handle('ai:cancelTurn', (_event, { requestId }) => aiService.cancelTurn(requestId));
  handle('ai:approvalResponse', (_event, { requestId, approvalId, approved }) =>
    aiService.respondApproval(requestId, approvalId, approved),
  );

  handle('settings:get', () => settings.read());
  handle('settings:update', (_event, patch) => {
    const next = settings.write(patch);
    // API bind address / token changes need a live server restart.
    if (
      patch && Object.prototype.hasOwnProperty.call(patch, 'api')
    ) {
      try {
        onSettingsChanged?.();
      } catch (error) {
        console.error('[magiespdf] settings change hook failed:', error.message);
      }
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoUpdate')) {
      try {
        updater.onAutoUpdatePreferenceChanged(next.autoUpdate !== false);
      } catch (error) {
        console.error('[magiespdf] auto-update preference hook failed:', error.message);
      }
    }
    return next;
  });

  const { getApiStatus } = require('./api/server.cjs');
  handle('api:status', () => getApiStatus());
  handle('mcp:config', () => {
    const packedServerPath = path.join(__dirname, 'mcp', 'magies-office-mcp-server.cjs');
    const serverPath = app.isPackaged
      ? packedServerPath.replace(
          `${path.sep}app.asar${path.sep}`,
          `${path.sep}app.asar.unpacked${path.sep}`,
        )
      : packedServerPath;
    return buildMcpClientConfig({
      execPath: process.execPath,
      serverPath,
      apiStatus: getApiStatus(),
      token: settings.read().api.token,
    });
  });
  handle('mcp:externalStatus', () => externalMcpManager.getStatus());
  handle('mcp:externalSetConfig', (_event, { config }) =>
    externalMcpManager.setConfig(config),
  );
  handle('mcp:externalRefresh', () => externalMcpManager.refresh());
  handle('mcp:externalClearConfig', () => externalMcpManager.clearConfig());

  handle('app:getVersion', () => app.getVersion());
  handle('app:isPackaged', () => app.isPackaged);

  // Update actions from Settings / corner prompt. Packages are unsigned (open source);
  // download may be automatic when autoUpdate is on, install is always explicit.
  handle('updater:check', async (event) => {
    const send = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('updater:status', status);
    };
    await updater.checkNow(send);
    return true;
  });
  handle('updater:download', async () => {
    await updater.downloadUpdate();
    return true;
  });
  handle('updater:install', async (event) => {
    const send = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('updater:status', status);
    };
    try {
      await updater.quitAndInstall();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ state: 'error', message, version: updater.getLastStatus?.()?.version });
      return { success: false, error: message };
    }
  });
  handle('updater:status', () => updater.getLastStatus?.() ?? { state: 'idle' });

  return { close: () => externalMcpManager.close() };
}

module.exports = {
  registerIpc,
  readCatalog,
  mimeOf,
  freeName,
  MAX_INPUT_BYTES,
  MAX_TOTAL_INPUT_BYTES,
  MAX_INPUT_FILES,
};
