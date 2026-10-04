const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { app } = require('electron');
const { createX2t, x2tExecutablePath } = require('./x2t.cjs');

/**
 * Where the vendored document engine lives, and how to drive its converter.
 *
 * The engine is a large unpacked download rather than a dependency: in a
 * checkout it sits under `vendor/` and is not in git; in a packaged app it is
 * copied into the app's resources. Everything that needs a path into it goes
 * through here so those two layouts are described in one place.
 */

const CONVERT_TIMEOUT_MS = 120000;

function engineRoot({
  packaged = app?.isPackaged ?? false,
  resourcesPath = process.resourcesPath ?? '',
  projectRoot = path.join(__dirname, '..', '..'),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (packaged) return path.join(resourcesPath, 'onlyoffice');
  // Only the matching platform's engine is packaged, so a checkout keeps them
  // side by side under the same names the LibreOffice runtime uses.
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform;
  return path.join(projectRoot, 'vendor', 'onlyoffice', `${os}-${arch}`);
}

/**
 * Everything of the engine that is not the converter.
 *
 * Only the converter is a native binary; the editor and its fonts are
 * javascript and data, identical on every platform. A checkout keeps one copy
 * of them rather than one per target — five targets would otherwise carry the
 * same data five times — while a packaged app composes both halves into the
 * single directory the runtime reads.
 */
function engineSharedRoot({
  packaged = app?.isPackaged ?? false,
  resourcesPath = process.resourcesPath ?? '',
  projectRoot = path.join(__dirname, '..', '..'),
} = {}) {
  if (packaged) return path.join(resourcesPath, 'onlyoffice');
  return path.join(projectRoot, 'vendor', 'onlyoffice', 'shared');
}

/**
 * Where the embedded editor's assets live.
 *
 * The Document Server build, under `web/`. It is the only build of the editor
 * that can save: the desktop build's save path is a call into a native host
 * that is not here. The app carries no desktop build at all — the converter
 * needs none, because PDF is rendered by the bundled LibreOffice.
 */
function editorAssetsRoot(options = {}) {
  return path.join(engineSharedRoot(options), 'web');
}

function runConverter(executable, args) {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout: CONVERT_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function createEngineX2t(options = {}) {
  const root = engineRoot(options);
  const shared = engineSharedRoot(options);
  const executable = x2tExecutablePath(root, options.platform ?? process.platform);
  // A work directory holds a copy of the document being converted, so it lives
  // in temp and is removed as soon as the bytes have been read.
  const tempRoot = path.join(os.tmpdir(), 'magies-office');
  const fontsDir = path.join(shared, 'fonts');

  return {
    ...createX2t({
      executable,
      fontsDir,
      tempRoot,
      fs,
      run: options.run ?? runConverter,
      uniqueId: () => crypto.randomUUID(),
    }),
    executablePath: executable,
    fontsDir,
    tempRoot,
  };
}

module.exports = { editorAssetsRoot, engineRoot, engineSharedRoot, createEngineX2t };
