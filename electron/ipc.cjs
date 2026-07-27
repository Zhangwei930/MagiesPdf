const fs = require('node:fs/promises');
const path = require('node:path');
const { app, dialog, ipcMain, shell } = require('electron');
const settings = require('./settings.cjs');
const mainRunner = require('./jobs/mainRunner.cjs');
const { createHostBridge } = require('./host.cjs');
const { collectFilePaths } = require('./files/walk.cjs');
const updater = require('./updater/index.cjs');

/**
 * IPC handlers. Every one of these is a boundary between untrusted renderer
 * input and the file system, so paths and sizes are checked here rather than
 * assumed to be sane.
 */

/** Refuse to slurp anything that cannot plausibly be a document we can process. */
const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;

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

async function readOne(absolutePath) {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${absolutePath}`);
  if (stat.size > MAX_INPUT_BYTES) {
    throw new Error(`File is too large to open (${(stat.size / 1024 ** 3).toFixed(1)} GB)`);
  }

  const buffer = await fs.readFile(absolutePath);
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

function registerIpc({ pool, getWindow, onSettingsChanged }) {
  ipcMain.handle('catalog:get', () => readCatalog().tools);

  ipcMain.handle('files:pick', async (_event, { accept, multiple }) => {
    const extensions = (accept ?? ['.pdf']).map((e) => e.replace(/^\./, ''));
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: extensions.join('/').toUpperCase(), extensions },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(readOne));
  });

  ipcMain.handle('files:read', async (_event, { paths }) => {
    if (!Array.isArray(paths)) return [];
    return Promise.all(paths.filter((p) => typeof p === 'string' && p !== '').map(readOne));
  });

  ipcMain.handle('files:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? '' : (result.filePaths[0] ?? '');
  });

  /**
   * Pick a folder and load matching files (optionally recursive) for batch work.
   * Caps at 200 files so a mistaken root directory cannot freeze the app.
   */
  ipcMain.handle('files:pickFolderFiles', async (_event, { accept, recursive }) => {
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
    const files = await Promise.all(paths.map(readOne));
    return { directory, files, truncated };
  });

  ipcMain.handle('files:save', async (_event, { files, options }) => {
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
      const name = overwrite ? file.name : await freeName(directory, file.name);
      const target = path.join(directory, name);
      await fs.writeFile(target, Buffer.from(file.bytes));
      written.push(target);
    }

    return { directory, written };
  });

  ipcMain.handle('files:saveAs', async (_event, { file }) => {
    const result = await dialog.showSaveDialog(getWindow(), { defaultPath: file.name });
    if (result.canceled || !result.filePath) return null;

    await fs.writeFile(result.filePath, Buffer.from(file.bytes));
    return { written: [result.filePath], directory: path.dirname(result.filePath) };
  });

  ipcMain.handle('shell:reveal', (_event, { path: target }) => {
    if (typeof target === 'string' && target !== '') shell.showItemInFolder(target);
    return true;
  });

  const hostBridge = createHostBridge();
  const runtimeOf = (toolId) =>
    readCatalog().tools.find((tool) => tool.id === toolId)?.runtime ?? 'worker';

  ipcMain.handle('job:run', async (event, request) => {
    const onProgress = (fraction, message) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send('job:progress', { jobId: request.jobId, fraction, message });
    };

    // Worker tools go to the thread pool; main tools need the host bridge
    // (printToPDF, external converter) and therefore run right here.
    return runtimeOf(request.toolId) === 'main'
      ? mainRunner.run(request, hostBridge, onProgress)
      : pool.run(request, onProgress);
  });

  ipcMain.handle('job:cancel', (_event, { jobId }) => pool.cancel(jobId) || mainRunner.cancel(jobId));

  ipcMain.handle('settings:get', () => settings.read());
  ipcMain.handle('settings:update', (_event, patch) => {
    const next = settings.write(patch);
    // API bind address / token changes need a live server restart.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'api')) {
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
  ipcMain.handle('api:status', () => getApiStatus());

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:isPackaged', () => app.isPackaged);

  // Manual update actions from Settings. Builds are unsigned (open source).
  ipcMain.handle('updater:check', async (event) => {
    const send = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('updater:status', status);
    };
    await updater.checkNow(send);
    return true;
  });
  ipcMain.handle('updater:download', async () => {
    await updater.downloadUpdate();
    return true;
  });
  ipcMain.handle('updater:install', () => {
    updater.quitAndInstall();
    return true;
  });
}

module.exports = { registerIpc, readCatalog, mimeOf, freeName, MAX_INPUT_BYTES };
