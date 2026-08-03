const fs = require('node:fs');
const path = require('node:path');

function runtimeOs(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return platform;
}

function officeRuntimeSource(projectRoot, platform, arch) {
  return path.join(projectRoot, 'vendor', 'office-runtime', `${runtimeOs(platform)}-${arch}`);
}

function officeRuntimeExecutable(root, platform) {
  if (platform === 'darwin') {
    return path.join(root, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice');
  }
  return path.join(root, 'program', platform === 'win32' ? 'soffice.exe' : 'soffice');
}

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assertOfficeRuntime({
  projectRoot,
  platform,
  arch,
  isExecutable = defaultIsExecutable,
}) {
  const source = officeRuntimeSource(projectRoot, platform, arch);
  const executable = officeRuntimeExecutable(source, platform);
  if (!isExecutable(executable)) {
    throw new Error(
      `Bundled Office runtime is missing for ${platform}-${arch}. ` +
      `Run npm run prepare:office-runtime -- --platform=${platform} --arch=${arch}`,
    );
  }
  return source;
}

function documentEngineSource(projectRoot, platform, arch) {
  return path.join(projectRoot, 'vendor', 'onlyoffice', `${runtimeOs(platform)}-${arch}`);
}

function defaultExists(candidate) {
  return fs.existsSync(candidate);
}

/**
 * Refuses to package without the document engine.
 *
 * A build missing it installs and starts perfectly well, and then fails the
 * first time anyone opens a Word file — so both halves are checked here: the
 * converter binary, and the font manifest that PDF rendering needs and whose
 * absence otherwise shows up only as an empty page.
 */
function assertDocumentEngine({ projectRoot, platform, arch, exists = defaultExists }) {
  const source = documentEngineSource(projectRoot, platform, arch);
  const converter = path.join(source, 'converter', platform === 'win32' ? 'x2t.exe' : 'x2t');
  if (!exists(converter)) {
    throw new Error(
      `Document engine is missing for ${platform}-${arch}. ` +
      `Run npm run prepare:engine -- --platform=${platform} --arch=${arch}`,
    );
  }

  const manifest = path.join(source, 'editors', 'sdkjs', 'common', 'AllFonts.js');
  if (!exists(manifest)) {
    throw new Error(
      `Document engine font manifest (AllFonts.js) is missing for ${platform}-${arch}; ` +
      'PDF rendering would produce nothing. Re-run npm run prepare:engine.',
    );
  }
  return source;
}

module.exports = {
  assertOfficeRuntime,
  officeRuntimeSource,
  assertDocumentEngine,
  documentEngineSource,
};
