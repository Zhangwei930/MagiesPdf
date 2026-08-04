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

function main() {
  const args = new Map(process.argv.slice(2)
    .filter((argument) => argument.startsWith('--'))
    .map((argument) => argument.slice(2).split('=')));

  const platform = args.get('platform') ?? process.platform;
  const arch = args.get('arch') ?? process.arch;
  const projectRoot = path.join(import.meta.dirname, '..');

  const asset = engineAsset({ platform, arch });
  const target = targetDirectory(projectRoot, { platform, arch });

  if (asset.kind === 'dmg' && process.platform !== 'darwin') {
    throw new Error('A macOS package can only be opened on macOS; prepare that target there.');
  }

  const file = download(asset, path.join(projectRoot, 'vendor', '.cache'));
  fs.rmSync(path.join(target, 'converter'), { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  extractConverter(file, asset, path.join(target, 'converter'));
  linkShared(target, projectRoot);

  console.log(`[engine] ${platform}-${arch} ready in ${path.relative(projectRoot, target)}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
