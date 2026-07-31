const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');
const settings = require('../settings.cjs');
const mainRunner = require('../jobs/mainRunner.cjs');
const { checkCollaboraServer, getCollaboraEditorAction } = require('./collabora.cjs');
const { isOfficeDocumentPath } = require('./formats.cjs');
const { wopiStore } = require('./wopi.cjs');
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

function createOfficeService(deps = {}) {
  const runtime = {
    dialog: deps.dialog ?? dialog,
    settings: deps.settings ?? settings,
    fs: deps.fs ?? fs,
    loadCore: deps.loadCore ?? mainRunner.loadCore,
    resolveExecutable: deps.resolveExecutable ?? resolveLibreOfficeExecutable,
    launch: deps.launch ?? launchLibreOffice,
    checkCollabora: deps.checkCollabora ?? checkCollaboraServer,
    collaboraAction: deps.collaboraAction ?? getCollaboraEditorAction,
    wopiStore: deps.wopiStore ?? wopiStore,
    getWopiServerStatus:
      deps.getWopiServerStatus ?? (() => require('../api/server.cjs').getApiStatus()),
  };

  const officeSettings = () => runtime.settings.read().office ?? {};
  const executable = () =>
    runtime.resolveExecutable({ configured: officeSettings().libreOfficeExecutable ?? '' });

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
      const configured = officeSettings();
      const resolved = executable();
      return {
        libreOffice: { available: resolved !== '', executable: resolved },
        collabora: {
          configured: Boolean(configured.collaboraUrl),
          serverUrl: configured.collaboraUrl ?? '',
        },
        wopiPublicUrl: configured.wopiPublicUrl ?? '',
      };
    },

    openPaths,
    create,

    async pickAndOpen(window, multiple = false) {
      const result = await runtime.dialog.showOpenDialog(window, {
        properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: OFFICE_FILTERS,
      });
      if (result.canceled) return { opened: [], canceled: true };
      return openPaths(result.filePaths);
    },

    async createAndOpen(window, kind) {
      const result = await create(window, kind);
      if (result.canceled) return { opened: [], canceled: true };
      return openPaths([result.created]);
    },

    checkCollabora() {
      return runtime.checkCollabora(officeSettings().collaboraUrl ?? '');
    },

    async prepareOnline(filePath) {
      const configured = officeSettings();
      if (!configured.collaboraUrl || !configured.wopiPublicUrl) {
        throw new Error('Collabora and the public WOPI URL are not configured');
      }
      if (!runtime.getWopiServerStatus().running) {
        throw new Error('The local WOPI server is not running');
      }
      if (!path.isAbsolute(filePath) || !isOfficeDocumentPath(filePath)) {
        throw new Error('An absolute supported Office document path is required');
      }
      const stat = await runtime.fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

      const action = await runtime.collaboraAction(
        configured.collaboraUrl,
        path.extname(filePath),
      );
      const session = await runtime.wopiStore.register(filePath);
      const wopiSource = `${configured.wopiPublicUrl.replace(/\/+$/, '')}/wopi/files/${encodeURIComponent(session.id)}`;
      const editorUrl = new URL(action);
      editorUrl.searchParams.set('WOPISrc', wopiSource);
      return {
        name: path.basename(filePath),
        editorUrl: editorUrl.toString(),
        accessToken: session.accessToken,
        accessTokenTtl: session.accessTokenTtl,
      };
    },
  };
}

module.exports = { CREATE_FILTERS, OFFICE_FILTERS, createOfficeService };
