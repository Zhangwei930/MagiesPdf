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
/**
 * What of the engine is worth shipping.
 *
 * As downloaded it is 1.8 GB, and most of that is never reached from here:
 * help documentation with screen recordings in a dozen languages, the mobile
 * and embedded builds of every editor, and editors for formats this app does
 * not open. `editors/` is the desktop build, which is here only because the
 * converter runs it to render PDFs — of its web-apps it reads exactly one
 * file, named in DoctRenderer.config.
 *
 * Everything listed is something a document does not pass through. Adding a
 * rule means being sure of that; the packaging tests name what must survive.
 */
function documentEngineFilter() {
  return [
    '**/*',
    '!**/resources/help/**',
    '!web/web-apps/apps/*/mobile/**',
    '!web/web-apps/apps/*/embed/**',
    '!web/web-apps/apps/*/forms/**',
    '!web/web-apps/apps/visioeditor/**',
    '!web/sdkjs/visio/**',
    // The converter reads one file from the desktop web-apps; the rest of that
    // build is a second copy of an editor nothing points a frame at.
    // The template gallery, which nothing here opens: it sits under the
    // converter, which is not served, and the converter itself renders and
    // converts without it. Creating a blank document uses converter/empty.
    '!converter/templates/**',
    '!editors/web-apps/apps/**',
    '!editors/web-apps/vendor/!(xregexp)/**',
  ];
}

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

  // The browser build is a separate half: the converter cannot serve an editor
  // and the editor cannot render a PDF. A package with only the first opens
  // documents and fails the moment anyone edits one.
  const browser = path.join(source, 'web', 'sdkjs', 'common', 'AllFonts.js');
  if (!exists(browser)) {
    throw new Error(
      `The editor's own build is missing for ${platform}-${arch}; documents would open ` +
      'but not edit. Re-run npm run prepare:engine, then npm run fonts:engine.',
    );
  }
  return source;
}

module.exports = {
  assertOfficeRuntime,
  officeRuntimeSource,
  assertDocumentEngine,
  documentEngineFilter,
  documentEngineSource,
};
