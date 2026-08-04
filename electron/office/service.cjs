const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { app, dialog, shell } = require('electron');
const settings = require('../settings.cjs');
const mainRunner = require('../jobs/mainRunner.cjs');
const { DOCUMENT_EXTENSIONS, isOfficeDocumentPath } = require('./formats.cjs');
const { officeRuntimeRoot, resolveLibreOfficeExecutable } = require('./libreOffice.cjs');
const { createOfficePreview } = require('./preview.cjs');
const { createLibreOfficeRenderer } = require('./libreOfficeRender.cjs');

const OFFICE_FILTERS = [
  { name: 'Office documents', extensions: ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'] },
];

const CREATE_FILTERS = {
  word: { name: 'Word document', extension: 'docx' },
  sheet: { name: 'Excel workbook', extension: 'xlsx' },
  slide: { name: 'PowerPoint presentation', extension: 'pptx' },
};

const RECENT_DOCUMENT_LIMIT = 20;
const LIBREOFFICE_DOWNLOAD_URL = 'https://www.libreoffice.org/download/';

function documentKind(candidate) {
  switch (path.extname(candidate).toLowerCase()) {
    case '.doc':
    case '.docx':
    case '.odt':
    case '.rtf':
      return 'word';
    case '.xls':
    case '.xlsx':
    case '.ods':
      return 'sheet';
    case '.ppt':
    case '.pptx':
    case '.odp':
      return 'slide';
    case '.pdf':
      return 'pdf';
    default:
      return '';
  }
}

function isDocumentPath(candidate) {
  return typeof candidate === 'string' && DOCUMENT_EXTENSIONS.has(path.extname(candidate).toLowerCase());
}

function normalizeLibreOfficeSelection(candidate, platform = process.platform) {
  if (platform === 'darwin' && candidate.toLowerCase().endsWith('.app')) {
    return path.join(candidate, 'Contents', 'MacOS', 'soffice');
  }
  return candidate;
}

/** Runs the renderer without a shell, and never lets a hang become forever. */
function runProcess(executable, args, { timeout } = {}) {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function createOfficeService(deps = {}) {
  const runtime = {
    dialog: deps.dialog ?? dialog,
    settings: deps.settings ?? settings,
    fs: deps.fs ?? fs,
    loadCore: deps.loadCore ?? mainRunner.loadCore,
    now: deps.now ?? Date.now,
    resolveExecutable: deps.resolveExecutable ?? resolveLibreOfficeExecutable,
    openExternal: deps.openExternal ?? ((url) => shell.openExternal(url)),
    trash: deps.trash ?? ((target) => shell.trashItem(target)),
    packaged: deps.packaged ?? app?.isPackaged ?? false,
    resourcesPath: deps.resourcesPath ?? process.resourcesPath ?? '',
    projectRoot: deps.projectRoot ?? path.join(__dirname, '..', '..'),
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    preview: deps.preview ?? null,
  };


  const officeSettings = () => runtime.settings.read().office ?? {};
  const recentSettings = () => runtime.settings.read().recentDocuments ?? [];
  const executable = () => runtime.resolveExecutable({
    bundledRoot: officeRuntimeRoot(runtime),
    configured: officeSettings().libreOfficeExecutable ?? '',
    packaged: runtime.packaged,
    platform: runtime.platform,
  });
  const status = () => {
    const resolved = executable();
    return { libreOffice: { available: resolved !== '', executable: resolved } };
  };

  /**
   * The preview renderer, resolved per call.
   *
   * Rendering runs through the bundled LibreOffice headlessly rather than the
   * ONLYOFFICE converter: it is already shipped, needs no font manifest, and
   * produces the same thing here — a PDF for the viewer. Building it per call
   * rather than once means a renderer located through settings is picked up
   * without restarting.
   */
  const previewService = () => runtime.preview ?? createOfficePreview({
    x2t: createLibreOfficeRenderer({
      executable: executable(),
      tempRoot: path.join(os.tmpdir(), 'magies-office'),
      fs: runtime.fs,
      run: runtime.runRenderer ?? runProcess,
      uniqueId: () => crypto.randomUUID(),
    }),
    fs: runtime.fs,
  });

  function writeRecent(recentDocuments) {
    runtime.settings.write({ recentDocuments: recentDocuments.slice(0, RECENT_DOCUMENT_LIMIT) });
  }

  function rememberRecent(paths) {
    let recentDocuments = [...recentSettings()];
    for (const candidate of paths) {
      if (!path.isAbsolute(candidate) || !isDocumentPath(candidate)) continue;
      recentDocuments = [
        { path: candidate, openedAt: runtime.now() },
        ...recentDocuments.filter((item) => item.path !== candidate),
      ];
    }
    writeRecent(recentDocuments);
  }

  function forgetRecent(candidate) {
    if (typeof candidate !== 'string') return { forgotten: false };
    const recentDocuments = recentSettings().filter((item) => item.path !== candidate);
    const forgotten = recentDocuments.length !== recentSettings().length;
    if (forgotten) writeRecent(recentDocuments);
    return { forgotten };
  }

  /**
   * Opens Office documents *inside* the app.
   *
   * This used to hand the files to a second application, which is what put two
   * windows on screen. Now each one is rendered to PDF and returned as bytes,
   * so it lands in the same tab strip as everything else. Nothing here depends
   * on another application being installed any more.
   */
  async function openPaths(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { opened: [], canceled: false, files: [] };
    }
    for (const candidate of paths) {
      if (!path.isAbsolute(candidate) || !isOfficeDocumentPath(candidate)) {
        throw new Error('An absolute supported Office document path is required');
      }
      const stat = await runtime.fs.stat(candidate);
      if (!stat.isFile()) throw new Error(`Not a file: ${candidate}`);
    }

    const files = await previewService().render(paths);
    rememberRecent(paths);
    return { opened: [...paths], canceled: false, files };
  }

  async function create(window, kind) {
    const filter = CREATE_FILTERS[kind];
    if (!filter) throw new Error(`Unsupported Office document kind: ${kind}`);
    const { createBlankOfficeDocument } = await runtime.loadCore();
    const file = createBlankOfficeDocument(kind);
    const result = await runtime.dialog.showSaveDialog(window, {
      defaultPath: file.name,
      filters: [{ name: filter.name, extensions: [filter.extension] }],
    });
    if (result.canceled || !result.filePath) return { created: '', canceled: true };

    await runtime.fs.writeFile(result.filePath, Buffer.from(file.bytes));
    return { created: result.filePath, canceled: false };
  }

  return {
    status,

    async pickExecutable(window) {
      const result = await runtime.dialog.showOpenDialog(window, {
        title: 'Locate LibreOffice',
        properties: ['openFile'],
        filters: [{ name: 'LibreOffice', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { canceled: true, status: status() };

      const selected = normalizeLibreOfficeSelection(result.filePaths[0]);
      const resolved = runtime.resolveExecutable({ configured: selected });
      if (resolved !== selected) throw new Error('The selected file is not a runnable LibreOffice executable');
      runtime.settings.write({ office: { libreOfficeExecutable: selected } });
      return { canceled: false, status: status() };
    },

    async openDownloadPage() {
      await runtime.openExternal(LIBREOFFICE_DOWNLOAD_URL);
      return { opened: true };
    },

    openPaths,
    create,
    rememberRecent,
    forgetRecent,

    async listRecent() {
      const recentDocuments = [];
      const result = [];
      for (const item of recentSettings()) {
        try {
          const stat = await runtime.fs.stat(item.path);
          if (!stat.isFile() || !isDocumentPath(item.path)) continue;
          recentDocuments.push(item);
          result.push({
            path: item.path,
            name: path.basename(item.path),
            kind: documentKind(item.path),
            openedAt: item.openedAt,
            modifiedAt: stat.mtimeMs ?? item.openedAt,
          });
        } catch (cause) {
          if (cause?.code !== 'ENOENT') throw cause;
        }
      }
      if (recentDocuments.length !== recentSettings().length) writeRecent(recentDocuments);
      return result;
    },

    async renameRecent(candidate, requestedName) {
      if (!path.isAbsolute(candidate) || !isDocumentPath(candidate)) {
        throw new Error('An absolute supported document path is required');
      }
      const stat = await runtime.fs.stat(candidate);
      if (!stat.isFile()) throw new Error(`Not a file: ${candidate}`);

      const name = typeof requestedName === 'string' ? requestedName.trim() : '';
      const hasControlCharacter = [...name].some((character) => character.charCodeAt(0) < 32);
      if (!name || name !== path.basename(name) || hasControlCharacter || name === '.' || name === '..') {
        throw new Error('A valid file name is required');
      }
      const originalExtension = path.extname(candidate);
      const requestedExtension = path.extname(name);
      if (requestedExtension && requestedExtension.toLowerCase() !== originalExtension.toLowerCase()) {
        throw new Error('Renaming cannot change the document format');
      }
      const targetName = requestedExtension ? name : `${name}${originalExtension}`;
      const target = path.join(path.dirname(candidate), targetName);
      if (target !== candidate) {
        try {
          await runtime.fs.access(target);
          throw new Error(`A file named ${targetName} already exists`);
        } catch (cause) {
          if (cause?.code !== 'ENOENT') throw cause;
        }
        await runtime.fs.rename(candidate, target);
      }

      const previous = recentSettings().find((item) => item.path === candidate);
      writeRecent([
        { path: target, openedAt: previous?.openedAt ?? runtime.now() },
        ...recentSettings().filter((item) => item.path !== candidate && item.path !== target),
      ]);
      return { path: target, name: targetName };
    },

    async trashRecent(candidate) {
      if (!path.isAbsolute(candidate) || !isDocumentPath(candidate)) {
        throw new Error('An absolute supported document path is required');
      }
      await runtime.trash(candidate);
      forgetRecent(candidate);
      return { trashed: true };
    },

    async pickAndOpen(window, multiple = false) {
      const result = await runtime.dialog.showOpenDialog(window, {
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: OFFICE_FILTERS,
      });
      if (result.canceled) return { opened: [], canceled: true, files: [] };
      return openPaths(result.filePaths);
    },

    /**
     * Creates a blank document and stops there.
     *
     * Opening is the caller's business: a new document goes to the editor by
     * the same route an existing one does, so the two paths cannot drift into
     * showing different things for the same file.
     */
    async createBlank(window, kind) {
      const result = await create(window, kind);
      return { created: result.created, canceled: result.canceled };
    },

    async createAndOpen(window, kind) {
      const result = await create(window, kind);
      if (result.canceled) return { opened: [], canceled: true, files: [] };
      return openPaths([result.created]);
    },
  };
}

module.exports = {
  CREATE_FILTERS,
  OFFICE_FILTERS,
  RECENT_DOCUMENT_LIMIT,
  LIBREOFFICE_DOWNLOAD_URL,
  normalizeLibreOfficeSelection,
  createOfficeService,
  documentKind,
};
