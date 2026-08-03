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

function runConverter(executable, args) {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout: CONVERT_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function createEngineX2t(options = {}) {
  const root = engineRoot(options);
  const executable = x2tExecutablePath(root, options.platform ?? process.platform);
  // A work directory holds a copy of the document being converted, so it lives
  // in temp and is removed as soon as the bytes have been read.
  const tempRoot = path.join(os.tmpdir(), 'magies-office');
  const allFontsPath = path.join(root, 'editors', 'sdkjs', 'common', 'AllFonts.js');

  return {
    ...createX2t({
      executable,
      fontsDir: path.join(root, 'fonts'),
      allFontsPath,
      tempRoot,
      fs,
      run: options.run ?? runConverter,
      uniqueId: () => crypto.randomUUID(),
    }),
    executablePath: executable,
    allFontsPath,
    tempRoot,
  };
}

module.exports = { engineRoot, createEngineX2t };
