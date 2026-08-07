import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Puts a target's document converter where the build expects it.
 *
 * Only the converter is native. The editor, its fonts and everything else the
 * engine needs are javascript and data, kept once under `vendor/onlyoffice/
 * shared` and linked into each target — so preparing a platform means taking
 * one directory out of that platform's desktop package and leaving the rest of
 * the 500 MB behind.
 *
 * Usage:
 *   node scripts/prepareEngine.mjs --platform=win32 --arch=arm64
 *
 * The package is cached, because it is large and the same one serves a rebuild.
 */

const RELEASE = 'v9.4.0';
const BASE = `https://github.com/ONLYOFFICE/DesktopEditors/releases/download/${RELEASE}`;

/**
 * The shared half: the editor itself, and the fonts it lays documents out with.
 *
 * The editor comes from Document Server rather than the desktop package,
 * because only that build can save — the desktop one's save path is a call
 * into a native host that is not here. Both are the same 9.4.0 engine.
 */
const DOCUMENT_SERVER = 'https://download.onlyoffice.com/install/documentserver/linux/onlyoffice-documentserver_amd64.deb';

/**
 * Documents written on Linux commonly name this outright, and the core fonts
 * do not include it — without it their text has no glyphs at all.
 *
 * Sans covers the black / UI faces (黑体, 微软雅黑). Serif is the Song / Fang
 * style (宋体, 仿宋) that Chinese office suites list separately; without it
 * those names have to fall back to a sans face and look wrong.
 */
const NOTO_SANS_CJK = 'https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/03_NotoSansCJK-OTC.zip';
const NOTO_SANS_WEIGHTS = ['NotoSansCJK-Regular.ttc', 'NotoSansCJK-Bold.ttc'];
const NOTO_SERIF_CJK = 'https://github.com/notofonts/noto-cjk/releases/download/Serif2.003/04_NotoSerifCJKOTC.zip';
const NOTO_SERIF_WEIGHTS = ['NotoSerifCJK-Regular.ttc', 'NotoSerifCJK-Bold.ttc'];

/**
 * Where each platform keeps the converter inside its own package. These are
 * what the packages contain, read from each of them — a wrong path here
 * prepares a target directory that looks right and holds no converter.
 */
const ASSETS = new Map([
  ['darwin-x64', { name: 'ONLYOFFICE-x86_64.dmg', kind: 'dmg', converter: 'ONLYOFFICE.app/Contents/Resources/converter' }],
  ['darwin-arm64', { name: 'ONLYOFFICE-arm.dmg', kind: 'dmg', converter: 'ONLYOFFICE.app/Contents/Resources/converter' }],
  ['win32-x64', { name: 'DesktopEditors_x64.zip', kind: 'zip', converter: 'converter' }],
  ['win32-arm64', { name: 'DesktopEditors_arm64.zip', kind: 'zip', converter: 'converter' }],
  ['linux-x64', { name: 'onlyoffice-desktopeditors_amd64.deb', kind: 'deb', converter: 'opt/onlyoffice/desktopeditors/converter' }],
  ['linux-arm64', { name: 'onlyoffice-desktopeditors_arm64.deb', kind: 'deb', converter: 'opt/onlyoffice/desktopeditors/converter' }],
]);

/** The package a target's converter comes from, and where it sits inside it. */
export function engineAsset({ platform, arch }) {
  const asset = ASSETS.get(`${platform}-${arch}`);
  if (!asset) throw new Error(`No document engine package is published for ${platform}-${arch}`);
  return asset;
}

/** The directory the build looks for a target's converter in. */
export function targetDirectory(projectRoot, { platform, arch }) {
  const os_ = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform;
  return path.join(projectRoot, 'vendor', 'onlyoffice', `${os_}-${arch}`);
}

/** The url the package is fetched from. */
export function assetUrl(asset) {
  return `${BASE}/${asset.name}`;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

function download(asset, cacheDir) {
  const file = path.join(cacheDir, asset.name);
  if (fs.existsSync(file)) {
    console.log(`[engine] using cached ${asset.name}`);
    return file;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log(`[engine] downloading ${asset.name}`);
  // To a temporary name, so an interrupted download is not cached as complete.
  const partial = `${file}.part`;
  run('curl', ['-fL', '--retry', '3', '-o', partial, assetUrl(asset)]);
  fs.renameSync(partial, file);
  return file;
}

/** Extracts the converter out of a package, whatever shape that package is. */
function extractConverter(file, asset, into) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-engine-'));
  try {
    if (asset.kind === 'dmg') {
      const output = execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', file]).toString();
      const mount = output.trim().split('\n').pop().split('\t').pop().trim();
      try {
        run('cp', ['-R', path.join(mount, asset.converter), into]);
      } finally {
        execFileSync('hdiutil', ['detach', mount], { stdio: 'ignore' });
      }
      return;
    }

    if (asset.kind === 'zip') {
      run('unzip', ['-q', file, `${asset.converter}/*`, '-d', staging]);
    } else {
      run('ar', ['x', file], { cwd: staging });
      const data = fs.readdirSync(staging).find((name) => name.startsWith('data.tar'));
      run('tar', ['-xf', path.join(staging, data), `./${asset.converter}`], { cwd: staging });
    }
    run('cp', ['-R', path.join(staging, asset.converter), into]);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Links the shared half in beside the converter.
 *
 * This makes a checkout the same shape as a packaged app, where both halves sit
 * in one directory — which matters because the converter's own
 * DoctRenderer.config reaches its scripts through `../editors`.
 */
function linkShared(target, projectRoot) {
  const shared = path.join(projectRoot, 'vendor', 'onlyoffice', 'shared');
  for (const name of fs.existsSync(shared) ? fs.readdirSync(shared) : []) {
    const link = path.join(target, name);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(path.join('..', 'shared', name), link);
  }
}

/** Fetches a url into the cache under a name of its own. */
function fetchInto(url, name, cacheDir) {
  const file = path.join(cacheDir, name);
  if (fs.existsSync(file)) {
    console.log(`[engine] using cached ${name}`);
    return file;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log(`[engine] downloading ${name}`);
  const partial = `${file}.part`;
  run('curl', ['-fL', '--retry', '3', '-o', partial, url]);
  fs.renameSync(partial, file);
  return file;
}

/**
 * Builds the half every platform shares.
 *
 * The fonts are flattened into one directory because the manifest names them
 * by filename, and the manifest is generated here rather than shipped: the one
 * that comes with the engine describes whichever machine generated it.
 */
function prepareShared(projectRoot, cacheDir) {
  const shared = path.join(projectRoot, 'vendor', 'onlyoffice', 'shared');
  const web = path.join(shared, 'web');
  const fonts = path.join(web, 'fonts');

  const deb = fetchInto(DOCUMENT_SERVER, 'onlyoffice-documentserver_amd64.deb', cacheDir);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-shared-'));
  try {
    run('ar', ['x', deb], { cwd: staging });
    const data = fs.readdirSync(staging).find((name) => name.startsWith('data.tar'));
    const inside = './var/www/onlyoffice/documentserver';
    run('tar', ['-xf', path.join(staging, data),
      `${inside}/sdkjs`, `${inside}/web-apps`, `${inside}/core-fonts`], { cwd: staging });

    const extracted = path.join(staging, 'var', 'www', 'onlyoffice', 'documentserver');
    fs.rmSync(web, { recursive: true, force: true });
    fs.mkdirSync(web, { recursive: true });
    run('cp', ['-R', path.join(extracted, 'sdkjs'), path.join(web, 'sdkjs')]);
    run('cp', ['-R', path.join(extracted, 'web-apps'), path.join(web, 'web-apps')]);

    // The fonts arrive as one directory per family and the manifest names
    // files, so they are flattened. Done here rather than with `find`, which
    // the Windows runner does not have.
    fs.mkdirSync(fonts, { recursive: true });
    const collect = (from) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (/\.(ttf|otf|ttc)$/i.test(entry.name)) {
          const into = path.join(fonts, entry.name);
          if (!fs.existsSync(into)) fs.copyFileSync(full, into);
        }
      }
    };
    collect(path.join(extracted, 'core-fonts'));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  // The help documentation is 595 MB of screen recordings in a dozen
  // languages, and is never packaged. Dropping it here as well keeps a
  // checkout — and the artifact this half travels as in CI — a third of the
  // size, rather than carrying it to be filtered out later.
  const dropHelp = (from) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(from, entry.name);
      if (entry.name === 'help') fs.rmSync(full, { recursive: true, force: true });
      else dropHelp(full);
    }
  };
  dropHelp(path.join(web, 'web-apps'));

  const notoSans = fetchInto(NOTO_SANS_CJK, '03_NotoSansCJK-OTC.zip', cacheDir);
  run('unzip', ['-o', '-q', '-j', notoSans, ...NOTO_SANS_WEIGHTS, 'LICENSE', '-d', fonts]);
  fs.renameSync(path.join(fonts, 'LICENSE'), path.join(fonts, 'LICENSE-NotoSansCJK.txt'));

  const notoSerif = fetchInto(NOTO_SERIF_CJK, '04_NotoSerifCJKOTC.zip', cacheDir);
  run('unzip', ['-o', '-q', '-j', notoSerif, ...NOTO_SERIF_WEIGHTS, 'LICENSE', '-d', fonts]);
  // The serif zip also ships a LICENSE; keep one copy of each licence text.
  if (fs.existsSync(path.join(fonts, 'LICENSE'))) {
    fs.renameSync(path.join(fonts, 'LICENSE'), path.join(fonts, 'LICENSE-NotoSerifCJK.txt'));
  }

  run('node', [path.join(projectRoot, 'scripts', 'onlyofficeFonts.mjs'), web]);
  console.log('[engine] shared half ready');
}

function main() {
  const args = new Map(process.argv.slice(2)
    .filter((argument) => argument.startsWith('--'))
    .map((argument) => argument.slice(2).split('=')));

  const platform = args.get('platform') ?? process.platform;
  const arch = args.get('arch') ?? process.arch;
  const projectRoot = path.join(import.meta.dirname, '..');

  const cacheDir = path.join(projectRoot, 'vendor', '.cache');
  if (args.has('shared')) {
    prepareShared(projectRoot, cacheDir);
    return;
  }

  const asset = engineAsset({ platform, arch });
  const target = targetDirectory(projectRoot, { platform, arch });

  if (asset.kind === 'dmg' && process.platform !== 'darwin') {
    throw new Error('A macOS package can only be opened on macOS; prepare that target there.');
  }

  const file = download(asset, cacheDir);
  fs.rmSync(path.join(target, 'converter'), { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  extractConverter(file, asset, path.join(target, 'converter'));
  linkShared(target, projectRoot);

  console.log(`[engine] ${platform}-${arch} ready in ${path.relative(projectRoot, target)}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
