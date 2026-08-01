const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog, shell } = require('electron');
const settings = require('../settings.cjs');
const mainRunner = require('../jobs/mainRunner.cjs');
const { DOCUMENT_EXTENSIONS, isOfficeDocumentPath } = require('./formats.cjs');
const {
  launchLibreOffice,
  resolveLibreOfficeExecutable,
} = require('./libreOffice.cjs');

const OFFICE_FILTERS = [
  { name: 'Office documents', extensions: ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'] },
];

const CREATE_FILTERS = {
  word: { name: 'Word document', extension: 'docx' },
  sheet: { name: 'Excel workbook', extension: 'xlsx' },
  slide: { name: 'PowerPoint presentation', extension: 'pptx' },
};

const RECENT_DOCUMENT_LIMIT = 20;

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

function createOfficeService(deps = {}) {
  const runtime = {
    dialog: deps.dialog ?? dialog,
    settings: deps.settings ?? settings,
    fs: deps.fs ?? fs,
    loadCore: deps.loadCore ?? mainRunner.loadCore,
    now: deps.now ?? Date.now,
    resolveExecutable: deps.resolveExecutable ?? resolveLibreOfficeExecutable,
    launch: deps.launch ?? launchLibreOffice,
    trash: deps.trash ?? ((target) => shell.trashItem(target)),
  };

  const officeSettings = () => runtime.settings.read().office ?? {};
  const recentSettings = () => runtime.settings.read().recentDocuments ?? [];
  const executable = () =>
    runtime.resolveExecutable({ configured: officeSettings().libreOfficeExecutable ?? '' });

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

  async function openPaths(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return { opened: [], canceled: false };
    for (const candidate of paths) {
      if (!path.isAbsolute(candidate) || !isOfficeDocumentPath(candidate)) {
        throw new Error('An absolute supported Office document path is required');
      }
      const stat = await runtime.fs.stat(candidate);
      if (!stat.isFile()) throw new Error(`Not a file: ${candidate}`);
    }

    const resolved = executable();
    if (!resolved) throw new Error('LibreOffice is not installed or configured');
    runtime.launch(resolved, paths);
    rememberRecent(paths);
    return { opened: [...paths], canceled: false };
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
    status() {
      const resolved = executable();
      return { libreOffice: { available: resolved !== '', executable: resolved } };
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
      if (result.canceled) return { opened: [], canceled: true };
      return openPaths(result.filePaths);
    },

    async createAndOpen(window, kind) {
      if (!executable()) throw new Error('LibreOffice is not installed or configured');
      const result = await create(window, kind);
      if (result.canceled) return { opened: [], canceled: true };
      return openPaths([result.created]);
    },
  };
}

module.exports = {
  CREATE_FILTERS,
  OFFICE_FILTERS,
  RECENT_DOCUMENT_LIMIT,
  createOfficeService,
  documentKind,
};
