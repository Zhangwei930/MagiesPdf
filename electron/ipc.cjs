const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow, app, dialog, ipcMain, protocol, shell } = require('electron');
const settings = require('./settings.cjs');
const mainRunner = require('./jobs/mainRunner.cjs');
const { createJobExecutor } = require('./jobs/executor.cjs');
const { createHostBridge } = require('./host.cjs');
const { collectFilePaths } = require('./files/walk.cjs');
const { InputBudget } = require('./files/inputBudget.cjs');
const writableTargets = require('./files/writableTargets.cjs');
const readableTargets = require('./files/readableTargets.cjs');
const { executableProblem } = require('./files/executable.cjs');
const updater = require('./updater/index.cjs');
const {
  PRINT_WINDOW_WEB_PREFERENCES,
  isTrustedIpcSender,
  safeFileName,
} = require('./security.cjs');
const {
  createPdfPrinter,
  whenDocumentSettles,
  whenDocumentRendered,
} = require('./print.cjs');
const { createOfficeService } = require('./office/service.cjs');
const { createOfficeSessions } = require('./office/session.cjs');
const { createEditorService } = require('./office/editorService.cjs');
const { createEditorRuntime } = require('./office/editorRuntime.cjs');
const { createDocumentSavedHandler } = require('./office/documentSaved.cjs');
const { createEngineX2t } = require('./office/engine.cjs');
const { createLibreOfficeRenderer } = require('./office/libreOfficeRender.cjs');
const {
  officeRuntimeRoot,
  resolveLibreOfficeExecutable,
} = require('./office/libreOffice.cjs');
const { DOCUMENT_EXTENSIONS, officeSaveAsDialogOptions, pdfExportName } = require('./office/formats.cjs');
const { createOfficeAutomationProvider } = require('./office/automationProvider.cjs');
const {
  IMAGE_PROVIDER_PRESETS,
  createImageSearchProvider,
  imagesFromModelProvider,
} = require('./ai/imageSearch.cjs');
const { createRendererApprovalPrompt } = require('./api/rendererApprovalPrompt.cjs');
const { runUnoOperation } = require('./office/unoRunner.cjs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { createAiService } = require('./ai/service.cjs');
const { createAiHistoryStore } = require('./ai/history.cjs');
const { createAutomationStore } = require('./ai/automationStore.cjs');
const { createAutomationEngine } = require('./ai/automationEngine.cjs');
const { getSecretStore } = require('./ai/secrets.cjs');
const {
  resolveActiveProvider,
  sanitizeProviderList,
  secretKeyForProvider,
} = require('./ai/providerStore.cjs');
const { createCliAgentService } = require('./ai/cliAgentService.cjs');
const { createCliRunner } = require('./ai/cliRunner.cjs');
const { modelPresetsFor, effortLevelsFor, sanitizeCliModels } = require('./ai/agentModels.cjs');
const { strictPrivacyRefusal } = require('./ai/privacy.cjs');
const { createWebSearchProvider, WEB_SEARCH_PRESETS } = require('./ai/webSearch.cjs');
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

function runLibreOffice(executable, args, { timeout } = {}) {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function registerIpc({ pool, getWindow, onSettingsChanged, trustedRendererUrl }) {
  const office = createOfficeService();
  const editorX2t = createEngineX2t();
  // PDF export and the office preview both go through LibreOffice. The
  // ONLYOFFICE converter's PDF path substitutes Japanese faces for Chinese
  // text; LO embeds real CJK fonts from the machine.
  const editorPdfRenderer = createLibreOfficeRenderer({
    executable: resolveLibreOfficeExecutable({
      bundledRoot: officeRuntimeRoot({
        packaged: app?.isPackaged ?? false,
        resourcesPath: process.resourcesPath ?? '',
      }),
      configured: settings.read().office?.libreOfficeExecutable ?? '',
      packaged: app?.isPackaged ?? false,
    }),
    tempRoot: path.join(os.tmpdir(), 'magies-office'),
    fs,
    run: runLibreOffice,
    uniqueId: () => crypto.randomUUID(),
  });
  const editorSessions = createOfficeSessions({
    x2t: editorX2t,
    pdfRenderer: editorPdfRenderer,
    fs,
    uniqueId: () => crypto.randomUUID(),
  });
  /** Where the next document out of a session goes, when it is a save-as. */
  const pendingSaveAs = new Map();

  const editorHost = createEditorRuntime({
    electron: { protocol },
    // The engine posts its document back when asked; that is the save.
    // "Save copy as" is not this path — those bytes are already converted and
    // sit on the host as an export (see office:editorSaveExport).
    onDocumentSaved: createDocumentSavedHandler({
      takeSaveAsTarget: (sessionId) => {
        const target = pendingSaveAs.get(sessionId);
        pendingSaveAs.delete(sessionId);
        return target;
      },
      save: (sessionId, base64) => editor.save(sessionId, base64),
      saveAs: (sessionId, base64, target) => editor.saveAs(sessionId, base64, target),
      rememberRecent: (paths) => office.rememberRecent(paths),
      notify: (channel, payload) => getWindow()?.webContents.send(channel, payload),
    }),
  });
  const editor = createEditorService({
    sessions: editorSessions,
    host: editorHost,
    fs,
    // x2t writes a document's images beside the binary it produced.
    listMedia: async (workDir) => {
      try {
        return await fs.readdir(path.join(workDir, 'media'));
      } catch {
        return [];
      }
    },
    rememberPaths: (paths) => office.rememberRecent(paths),
  });
  const sameAbsolutePath = async (left, right) => {
    if (!left || !right) return false;
    try {
      return (await fs.realpath(left)) === (await fs.realpath(right));
    } catch {
      return path.resolve(left) === path.resolve(right);
    }
  };

  /**
   * AI mutates files on disk. If the embedded editor still holds that path,
   * its stale Editor.bin would clobber the result on the next save — so close
   * matching sessions first, then ask the renderer to reopen after apply.
   */
  const closeEditorsForPath = async (absolutePath) => {
    const closed = [];
    for (const session of editorSessions.list()) {
      if (!(await sameAbsolutePath(session.path, absolutePath))) continue;
      // Closing the session throws away whatever the user typed and has not
      // saved. Refuse instead: the AI's edit can wait for a ⌘S, the user's
      // paragraph cannot be recovered.
      if (session.modified) {
        throw new Error(
          `${session.name} 在编辑器中有未保存的修改，请先保存（⌘S / Ctrl+S）再让 AI 修改这个文件。`
          + ` / ${session.name} has unsaved changes in the editor. Save it first, then run this tool again.`,
        );
      }
      await editor.close(session.id);
      closed.push({ sessionId: session.id, path: session.path });
    }
    if (closed.length > 0) {
      const window = getWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send('office:sessionsClosed', { sessions: closed });
      }
    }
    return closed;
  };

  const officeToolApprovals = createRendererApprovalPrompt({ getWindow });

  /**
   * What the picture provider needs to borrow the model provider's images
   * endpoint. Nothing here is sent to the renderer.
   */
  const activeModelProviderCredentials = (ai) => {
    const active = resolveActiveProvider(ai);
    if (!active) return null;
    return {
      baseUrl: active.baseUrl,
      apiKey: secretStore.getSecret(secretKeyForProvider(active.id)),
    };
  };

  const officeAutomation = createOfficeAutomationProvider({
    /**
     * Pictures are read fresh on every call, so turning the provider on — or
     * switching strict local privacy — takes effect without a restart.
     */
    createImageProvider: (saveImage) => createImageSearchProvider({
      saveImage,
      readConfig: () => {
        const ai = settings.read().ai || {};
        return {
          ...(ai.images || {}),
          strictLocalPrivacy: ai.strictLocalPrivacy === true,
          apiKey: secretStore.getImageSearchKey(),
          modelProvider: activeModelProviderCredentials(ai),
        };
      },
    }),
    getLibreOfficeExecutable: () => office.status().libreOffice.executable,
    runUno: runUnoOperation,
    onBeforeDocumentWrite: closeEditorsForPath,
    onAfterDocumentWrite: async (absolutePath) => {
      const window = getWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send('office:documentApplied', { path: absolutePath });
      }
    },
  });
  const handle = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event, getWindow(), trustedRendererUrl)) {
        throw new Error(`Rejected untrusted IPC request: ${channel}`);
      }
      return handler(event, ...args);
    });
  };

  handle('catalog:get', () => readCatalog().tools);

  handle('office:createBlank', (_event, { kind }) => office.createBlank(getWindow(), kind));
  // The embedded editor. Paths are validated by the session layer, which
  // refuses anything relative or of a format no editor opens.
  handle('office:editorOpen', (_event, { paths, uiTheme }) =>
    editor.open(
      Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [],
      { uiTheme: typeof uiTheme === 'string' ? uiTheme : 'theme-white' },
    ),
  );
  // Start the loopback host early and name the static files the renderer
  // should pull into Chromium's cache before the user opens a document.
  handle('office:editorWarm', () => editor.warm());
  // Do not block IPC registration; a failure just means the first open pays.
  void editor.warm().catch(() => {});
  handle('office:editorFocus', (_event, { sessionId }) => {
    editor.focus(String(sessionId));
    return { focused: true };
  });
  handle('office:editorSave', (_event, { sessionId, bytes }) =>
    editor.save(String(sessionId), String(bytes)),
  );
  /**
   * The file menu's "save as" — one OS dialog, like WPS.
   *
   * The renderer has none of the document — it is in the engine — so this
   * only asks where it should go and remembers that. The save that follows
   * takes the ordinary path out of the engine, and lands there instead of
   * over the original. Filters cover the common formats; the extension
   * decides conversion (PDF through LibreOffice for correct CJK).
   */
  handle('office:editorSaveAsTarget', async (_event, { sessionId, name, kind }) => {
    // "输出为 PDF" proposes a .pdf, which also narrows the type dropdown to
    // PDF alone — otherwise confirming the default turns an export into an
    // ordinary Save As over the original document.
    const proposed = kind === 'pdf' ? pdfExportName(String(name || '')) : String(name || '');
    const suggested = safeFileName(proposed);
    const result = await dialog.showSaveDialog(
      getWindow(),
      officeSaveAsDialogOptions(suggested),
    );
    if (result.canceled || !result.filePath) return null;

    pendingSaveAs.set(String(sessionId), result.filePath);
    writableTargets.remember(result.filePath);
    return { path: result.filePath };
  });

  /**
   * Fallback when the engine has already produced a copy (format panel path).
   *
   * The preferred path is path-first via office:editorSaveAsTarget. This still
   * runs if a finished export arrives from an unpatched engine menu click.
   */
  handle('office:editorSaveExport', async (_event, { sessionId, name }) => {
    const suggested = safeFileName(String(name || ''));
    const result = await dialog.showSaveDialog(
      getWindow(),
      officeSaveAsDialogOptions(suggested),
    );
    if (result.canceled || !result.filePath) return null;

    writableTargets.remember(result.filePath);
    const written = await editor.writeExport(String(sessionId), result.filePath);
    office.rememberRecent([written.path]);
    return written;
  });

  handle('office:editorClose', (_event, { sessionId }) => editor.close(String(sessionId)));
  /**
   * The engine reports edits to the renderer, which owns the dirty flag. The
   * main process needs it too, so an AI write can refuse a file the user is
   * still typing into (see closeEditorsForPath).
   */
  handle('office:editorModified', (_event, { sessionId, modified }) => {
    try {
      return editorSessions.setModified(String(sessionId), modified === true);
    } catch {
      // The tab closed between the engine's edit and this message: a session
      // that no longer exists has nothing left to protect.
      return null;
    }
  });

  handle('office:listRecent', () => {
    const recent = office.listRecent();
    // Offered back to the user as their own history; opening one from the list
    // is the same act as opening it the first time.
    readableTargets.grantAll(
      (Array.isArray(recent) ? recent : []).map((entry) => entry?.path).filter(Boolean),
    );
    return recent;
  });
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
    // Chosen by the user in a dialog this process opened: that is the grant.
    readableTargets.grantAll(result.filePaths);
    return readMany(result.filePaths);
  });

  handle('files:pickDocumentPaths', async (_event, { multiple }) => {
    const extensions = [...DOCUMENT_EXTENSIONS].map((extension) => extension.slice(1));
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Documents', extensions }],
    });
    if (result.canceled) return [];
    readableTargets.grantAll(result.filePaths);
    return result.filePaths;
  });

  // A drop is a user action the renderer cannot fabricate: `webUtils` resolves
  // a real `File` and nothing else. Sent rather than invoked because the
  // renderer has no use for an answer.
  ipcMain.on('files:grantDropped', (event, payload) => {
    if (!isTrustedIpcSender(event, getWindow(), trustedRendererUrl)) return;
    if (typeof payload?.path === 'string') readableTargets.grant(payload.path);
  });

  handle('files:read', async (_event, { paths }) => {
    if (!Array.isArray(paths)) return [];
    const targets = paths.filter((p) => typeof p === 'string' && p !== '');
    // Naming a path is not permission to read it. Every path here came from a
    // dialog, a drop, the recent list or argv — the four places the main
    // process grants — so anything else is a renderer asking for something no
    // user action asked for.
    const denied = targets.filter((target) => !readableTargets.isReadable(target));
    if (denied.length > 0) {
      throw new Error(`Not authorised to read: ${denied.map((p) => path.basename(p)).join(', ')}`);
    }
    const files = await readMany(targets);
    office.rememberRecent(targets);
    return files;
  });

  /**
   * Picking the external converter needs its path and nothing else.
   *
   * `files:pick` would read the whole binary into memory, ship it over IPC,
   * refuse anything past the 512 MiB input cap, and hand the renderer the
   * right to overwrite it. None of that serves choosing a program to run, so
   * this returns the path and checks that it is one that can be run.
   */
  handle('files:pickExecutable', async () => {
    const result = await dialog.showOpenDialog(getWindow(), {
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'com'] }]
          : [{ name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const target = result.filePaths[0];
    let stat = null;
    try {
      stat = await fs.stat(target);
    } catch {
      stat = null;
    }
    const problem = executableProblem({ stat, path: target });
    // Deliberately no grant: the converter is run, never read or written by
    // the renderer.
    return problem ? { path: '', problem } : { path: target };
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
    readableTargets.grantAll(paths);
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
  /**
   * Prints the document, not the window.
   *
   * Printing used to go through the renderer's own web contents, which printed
   * the application: chrome, panels, and only the pages the viewer had
   * mounted. The bytes now go to a temp file that Chromium's own PDF viewer
   * opens in a window nobody sees, and that is what is printed (issue #27).
   * Bytes rather than a path, so what comes out is what the tab is showing,
   * unsaved edits included. See print.cjs.
   */
  const pdfPrinter = createPdfPrinter({
    writeTemp: async (bytes, fileName) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-print-'));
      const target = path.join(directory, fileName);
      await fs.writeFile(target, Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength));
      return { path: target, directory };
    },
    removeTemp: (directory) => fs.rm(directory, { recursive: true, force: true }),
    openWindow: async (filePath, { expectedPages = 0 } = {}) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { ...PRINT_WINDOW_WEB_PREFERENCES },
      });
      try {
        await window.loadFile(filePath);
        // Loading is not the same as having the document: the viewer loads
        // again on its own, and printing too early produces a single blank
        // page. Settling is the cheap half; the render check is the half that
        // holds when the machine is busy. See print.cjs.
        await whenDocumentSettles(window.webContents);
        await whenDocumentRendered(window.webContents, { expectedPages });
      } catch (cause) {
        window.destroy();
        throw cause;
      }
      return {
        print: (options) => new Promise((resolve, reject) => {
          window.webContents.print(options, (printed, reason) => {
            // "cancelled" is the user closing the dialog, which is an answer,
            // not a failure — the only reason that is not an error.
            if (printed || reason === 'cancelled') resolve({ printed, reason });
            else reject(new Error(reason || 'The document could not be printed'));
          });
        }),
        destroy: () => {
          if (!window.isDestroyed()) window.destroy();
        },
      };
    },
  });
  handle('app:printPdf', (_event, { bytes, name, pages } = {}) => pdfPrinter.print(bytes, {
    name,
    // How many pages the renderer laid out. It is a hint used only to tell a
    // finished render from an unready one, so anything odd simply means "do
    // not check" rather than being rejected.
    pages: Number.isInteger(pages) && pages > 0 ? pages : 0,
  }));

  const hostBridge = createHostBridge();
  const secretStore = getSecretStore();
  const aiHistory = createAiHistoryStore({
    filePath: path.join(app.getPath('userData'), 'ai-history.json'),
  });
  const automationStore = createAutomationStore({
    filePath: path.join(app.getPath('userData'), 'ai-automations.json'),
  });
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
  /**
   * Reads its configuration fresh on every call so toggling search — or strict
   * local privacy — takes effect on the next turn without a restart.
   */
  const webSearchProvider = createWebSearchProvider({
    readConfig: () => {
      const ai = settings.read().ai || {};
      return {
        ...(ai.webSearch || {}),
        strictLocalPrivacy: ai.strictLocalPrivacy === true,
        apiKey: secretStore.getWebSearchKey(),
      };
    },
  });

  const aiService = createAiService({
    readCatalog,
    readSettings: settings.read,
    secretStore,
    externalToolProvider: externalMcpManager,
    officeToolProvider: officeAutomation,
    webSearchProvider,
    executeTool: ({ signal, onProgress, ...request }) =>
      jobExecutor.run(request, onProgress, signal),
  });
  const automationState = async () => ({
    ...automationStore.getState(),
    tools: (await officeAutomation.listTools())
      .filter(({ unattended }) => unattended !== false)
      .map(({ toolId, name }) => ({ toolId, toolName: name })),
  });
  const automationEngine = createAutomationEngine({
    store: automationStore,
    officeProvider: officeAutomation,
    aiService,
    emit: (payload) => {
      const window = getWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send('ai:automationEvent', payload);
      }
    },
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
  handle('ai:setApiKey', (_event, { apiKey, providerId }) =>
    aiService.setApiKey(apiKey, providerId));
  // `cliAgents` is created further down with the MCP config it needs; this only
  // reaches for it when a turn actually runs, by which point it exists.
  const cliRunner = createCliRunner({
    resolveAgent: async (agentId) =>
      (await cliAgents.detect()).find((agent) => agent.id === agentId) ?? null,
  });

  /**
   * A turn goes to the built-in runtime unless the panel selected a CLI agent,
   * in which case that CLI executes it in the granted Office workspace and its
   * output is streamed back through the same events.
   */
  const cliTurns = new Map();
  handle('ai:runTurn', async (event, request) => {
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:event', payload);
    };

    const agent = String(request?.agent || '');
    if (!agent.startsWith('cli:')) return aiService.runTurn(request, send);

    const refusal = strictPrivacyRefusal({
      strict: settings.read().ai?.strictLocalPrivacy === true,
      agent,
    });
    if (refusal) {
      const error = new Error(refusal.userMessage.zh);
      error.code = refusal.code;
      throw error;
    }

    // CLI is brain-only: Magies hands require the local API + magies-office MCP.
    // Without them the agent would fall back to shell/Python — refuse instead.
    // (mcpClientConfig is defined later in this function; handlers run after init.)
    if (typeof mcpClientConfig !== 'function' || !mcpClientConfig().ready) {
      const reason = typeof mcpClientConfig === 'function' ? mcpClientConfig().reason : '';
      // message is what the renderer surfaces — keep it bilingual-useful for users.
      const error = new Error(
        reason
          || '请先在设置中启用本地 API 并生成令牌，再安装 magies-office MCP。命令行只能通过 Magies 工具操作 Office。 / Enable the local API + token and install magies-office MCP first.',
      );
      error.code = 'AI_MCP_REQUIRED';
      throw error;
    }

    const requestId = String(request?.requestId || '');
    const controller = new AbortController();
    cliTurns.set(requestId, controller);
    try {
      const agentId = agent.slice(4);
      const ai = settings.read().ai || {};
      const choice = (ai.cliModels || {})[agentId] || {};
      // The CLI is another process: it sees neither the granted folder nor the
      // document open in this window unless it is told.
      const [openFile] = Array.isArray(request.files) ? request.files : [];
      return await cliRunner.run({
        agentId,
        prompt: request.prompt,
        model: choice.model || '',
        effort: choice.effort || '',
        // observer | confirm | auto — writes gated again on Magies REST/MCP.
        permissionMode: ai.permissionMode === 'auto' || ai.permissionMode === 'observer'
          ? ai.permissionMode
          : 'confirm',
        // Never honor CLI "unattended" skip-permissions — Magies constraints only.
        unattended: false,
        // The panel's own history tells us this is a follow-up; the CLI keeps
        // the conversation on its side, so it only needs to be told to resume.
        resume: Array.isArray(request.history) && request.history.length > 0,
        openDocument: openFile ? { name: openFile.name, path: openFile.path || '' } : null,
        // Same session memory the built-in runtime gets, so CLI follow-ups
        // still know which Office file earlier turns produced.
        sessionMemory: request.officeContext?.sessionMemory || null,
        cwd: officeAutomation.getWorkspaceStatus().path,
        signal: controller.signal,
        onEvent: (payload) => send({ requestId, ...payload }),
      });
    } finally {
      cliTurns.delete(requestId);
    }
  });
  handle('ai:cancelTurn', (_event, { requestId }) => {
    const cliTurn = cliTurns.get(requestId);
    if (cliTurn) {
      cliTurn.abort();
      return true;
    }
    return aiService.cancelTurn(requestId);
  });
  handle('ai:approvalResponse', (_event, { requestId, approvalId, approved }) =>
    aiService.respondApproval(requestId, approvalId, approved),
  );
  handle('ai:workspaceStatus', () => officeAutomation.getWorkspaceStatus());
  handle('ai:pickWorkspace', async () => {
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return officeAutomation.getWorkspaceStatus();
    return officeAutomation.setWorkspaceRoot(result.filePaths[0]);
  });
  handle('ai:grantWorkspaceForPath', async (_event, { path: documentPath }) =>
    officeAutomation.setWorkspaceFromDocumentPath(documentPath));
  handle('ai:clearWorkspace', () => officeAutomation.clearWorkspace());
  handle('ai:historyList', () => aiHistory.list());
  handle('ai:historyAppend', (_event, entry) => aiHistory.append(entry));
  /**
   * Office tools arriving over REST/MCP ask the user here, in the AI panel,
   * rather than through an OS dialog. `main.cjs` owns the gate that calls this.
   */
  handle('office:toolApprovalResponse', (_event, { approvalId, decision }) =>
    officeToolApprovals.respond(approvalId, decision));
  handle('ai:historyRemove', (_event, { id }) => aiHistory.remove(String(id ?? '')));
  handle('ai:historyClear', () => aiHistory.clear());
  handle('ai:automationState', () => automationState());
  handle('ai:automationCreate', async (_event, rule) => {
    automationStore.createRule(rule);
    return automationState();
  });
  handle('ai:automationSetEnabled', async (_event, { ruleId, enabled }) => {
    automationStore.setRuleEnabled(ruleId, enabled);
    return automationState();
  });
  handle('ai:automationDelete', async (_event, { ruleId }) => {
    automationStore.deleteRule(ruleId);
    return automationState();
  });
  handle('ai:automationResolvePending', async (_event, { pendingId }) => {
    automationStore.resolvePending(pendingId);
    return automationState();
  });

  handle('settings:get', () => settings.read());
  handle('settings:update', (_event, patch) => {
    // The renderer sends the provider list; strip it to known fields so a key
    // can never be persisted in plaintext next to the rest of the settings.
    // The provider list and the per-CLI choices both arrive from the renderer
    // and both bypass the settings whitelist, so both are vetted here.
    const safePatch = patch?.ai
      ? {
          ...patch,
          ai: {
            ...patch.ai,
            ...(patch.ai.providers ? { providers: sanitizeProviderList(patch.ai.providers) } : {}),
            ...(patch.ai.cliModels ? { cliModels: sanitizeCliModels(patch.ai.cliModels) } : {}),
          },
        }
      : patch;
    const next = settings.write(safePatch);
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
  const mcpClientConfig = () => {
    // Inside the asar, deliberately. `electron/mcp/**` is unpacked so the SDK
    // and its dependencies can be loaded, but the entry also requires
    // `../ai/toolCatalog.cjs` and the root `package.json`, which are not —
    // so the unpacked copy died at require time and every packaged install
    // wrote a broken MCP entry into every CLI it was added to. Electron reads
    // the archive transparently under ELECTRON_RUN_AS_NODE, and maps the
    // unpacked dependencies back on its own.
    const serverPath = path.join(__dirname, 'mcp', 'magies-office-mcp-server.cjs');
    return buildMcpClientConfig({
      execPath: process.execPath,
      serverPath,
      apiStatus: getApiStatus(),
      token: settings.read().api.token,
    });
  };
  handle('mcp:config', () => mcpClientConfig());

  // Coding-agent CLIs on this machine, and adding our MCP server to them.
  const cliAgents = createCliAgentService({ mcpConfig: mcpClientConfig });
  handle('websearch:status', () => {
    const ai = settings.read().ai || {};
    return {
      presets: WEB_SEARCH_PRESETS.map(({ id, name, requiresApiKey, hint }) => ({
        id, name, requiresApiKey, hint,
      })),
      enabled: ai.webSearch?.enabled === true,
      provider: ai.webSearch?.provider || 'tavily',
      endpoint: ai.webSearch?.endpoint || '',
      apiKeyConfigured: secretStore.hasWebSearchKey(),
      blockedByPrivacy: ai.strictLocalPrivacy === true,
    };
  });
  handle('websearch:setKey', (_event, { apiKey }) => {
    secretStore.setWebSearchKey(String(apiKey || ''));
    return { apiKeyConfigured: secretStore.hasWebSearchKey() };
  });
  handle('images:status', () => {
    const ai = settings.read().ai || {};
    // What 'auto' came to, so the pane can say whether the configured model
    // provider actually serves pictures rather than implying that it does.
    const borrowed = imagesFromModelProvider(activeModelProviderCredentials(ai));
    return {
      presets: IMAGE_PROVIDER_PRESETS,
      enabled: ai.images?.enabled === true,
      provider: ai.images?.provider || 'auto',
      endpoint: ai.images?.endpoint || '',
      model: ai.images?.model || '',
      apiKeyConfigured: secretStore.hasImageSearchKey(),
      blockedByPrivacy: ai.strictLocalPrivacy === true,
      followsModelProvider: borrowed
        ? { endpoint: borrowed.endpoint, model: borrowed.model }
        : null,
    };
  });
  handle('images:setKey', (_event, { apiKey }) => {
    secretStore.setImageSearchKey(String(apiKey || ''));
    return { apiKeyConfigured: secretStore.hasImageSearchKey() };
  });

  handle('cli:agents', async () => (await cliAgents.detect()).map((agent) => ({
    ...agent,
    models: modelPresetsFor(agent.id),
    effortLevels: effortLevelsFor(agent.id),
  })));
  handle('cli:installMcp', (_event, { agentId }) => cliAgents.install(agentId));
  handle('cli:models', (_event, { agentId }) => cliAgents.listModels(agentId));
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

  automationEngine.start();

  return {
    /** Shared with the local REST API / MCP so Office tools are one surface. */
    officeAutomation,
    /** How the REST/MCP approval gate puts its question in front of the user. */
    requestToolApproval: officeToolApprovals.prompt,
    close: async () => {
      officeToolApprovals.clear();
      automationEngine.stop();
      // Every open Office session holds a copy of the user's document in a
      // work directory, and the host serving them holds a loopback port.
      // Closing a tab removes both; quitting closes no tabs, so this is the
      // only thing that ever removes the last ones (issue #29).
      await editor.closeAll();
      await externalMcpManager.close();
    },
  };
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
