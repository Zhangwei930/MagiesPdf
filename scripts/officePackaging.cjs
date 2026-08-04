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
/**
 * What of the shared half is worth shipping.
 *
 * As downloaded the engine is 1.8 GB, and most of it is never reached from
 * here: help documentation with screen recordings in a dozen languages, the
 * mobile and embedded builds of every editor, and editors for formats this app
 * does not open.
 *
 * Paths are relative to `vendor/onlyoffice/shared`, which is the directory
 * this half is copied from. Everything listed is something a document does not
 * pass through; adding a rule means being sure of that, and the packaging
 * tests name what must survive.
 */
function sharedEngineFilter() {
  return [
    '**/*',
    '!**/resources/help/**',
    '!web/web-apps/apps/*/mobile/**',
    '!web/web-apps/apps/*/embed/**',
    '!web/web-apps/apps/*/forms/**',
    '!web/sdkjs/visio/**',
    // PDFs open in this app's own viewer; the engine's pdf editor is never
    // pointed at one — nothing in web-apps so much as names it.
    '!web/sdkjs/pdf/**',
    // The editor ships in 46 languages. This app ships in two.
    '!web/web-apps/apps/*/main/locale/*.json',
    'web/web-apps/apps/*/main/locale/{en,zh}.json',
    // Whole editors go last: the rule above re-includes rather than excludes,
    // and its wildcard reaches every editor — including ones meant to be gone.
    // Rules apply in order and the last to match decides.
    '!web/web-apps/apps/visioeditor/**',
    // The desktop build, and the font data generated for it. Both exist for
    // one thing: rendering PDFs through the converter. Nothing here does that
    // — the preview goes through the bundled LibreOffice, which needs no font
    // manifest and behaves the same on every platform. Shipping them would
    // also ship a manifest describing whichever machine built the package.
    '!editors/**',
    '!fonts/**',
  ];
}

/**
 * What of the converter is worth shipping.
 *
 * Separate from the shared half because it is copied from its own directory,
 * so these paths start inside the converter rather than above it. A rule
 * written against the wrong root matches nothing and quietly ships what it
 * was meant to drop.
 */
function converterFilter() {
  return [
    '**/*',
    // The template gallery, which nothing here opens: it sits under the
    // converter, which is not served, and the converter itself renders and
    // converts without it. Creating a blank document uses `empty/`.
    '!templates/**',
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
  converterFilter,
  documentEngineSource,
  sharedEngineFilter,
};
