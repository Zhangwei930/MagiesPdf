import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function parseManifest(source, label) {
  const version = source.match(/^version:\s*(\S+)$/m)?.[1];
  const releaseDate = source.match(/^releaseDate:\s*(.+)$/m)?.[1];
  const files = [...source.matchAll(
    /^ {2}- url: (.+)\n {4}sha512: (.+)\n {4}size: (\d+)(?:\n {4}blockMapSize: (\d+))?/gm,
  )].map((match) => ({
    url: match[1],
    sha512: match[2],
    size: Number(match[3]),
    blockMapSize: match[4] === undefined ? undefined : Number(match[4]),
  }));

  if (!version || !releaseDate || files.length === 0) {
    throw new Error(`${label} is not a complete electron-builder update manifest`);
  }
  return { version, releaseDate, files };
}

function renderFile(file) {
  const lines = [
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
  ];
  if (file.blockMapSize !== undefined) lines.push(`    blockMapSize: ${file.blockMapSize}`);
  return lines.join('\n');
}

export function mergeMacUpdateManifests(x64Source, arm64Source, { minimumSystemVersion } = {}) {
  const x64 = parseManifest(x64Source, 'x64 manifest');
  const arm64 = parseManifest(arm64Source, 'arm64 manifest');

  if (x64.version !== arm64.version) {
    throw new Error('macOS update manifests must have the same version');
  }
  if (!x64.files.every((file) => file.url.includes('mac-x64'))) {
    throw new Error('x64 manifest contains a non-x64 asset');
  }
  if (!arm64.files.every((file) => file.url.includes('mac-arm64'))) {
    throw new Error('arm64 manifest contains a non-arm64 asset');
  }

  const files = [...x64.files, ...arm64.files];
  if (new Set(files.map((file) => file.url)).size !== files.length) {
    throw new Error('macOS update manifests contain duplicate assets');
  }
  const defaultFile = x64.files.find((file) => file.url.endsWith('.zip'));
  if (!defaultFile) throw new Error('x64 manifest does not contain a zip asset');

  return [
    `version: ${x64.version}`,
    'files:',
    ...files.map(renderFile),
    `path: ${defaultFile.url}`,
    `sha512: ${defaultFile.sha512}`,
    `releaseDate: ${x64.releaseDate}`,
    // electron-updater compares this against the running OS and skips the
    // release when it is lower. It never reads the bundle's plist, so a floor
    // declared only for packaging would still let the update install here and
    // replace a working app with one that cannot launch.
    ...(minimumSystemVersion ? [`minimumSystemVersion: ${minimumSystemVersion}`] : []),
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [x64Path, arm64Path, outputPath] = process.argv.slice(2);
  if (!x64Path || !arm64Path || !outputPath) {
    throw new Error('Usage: node scripts/mergeMacUpdateManifests.mjs <x64.yml> <arm64.yml> <output.yml>');
  }
  const [x64Source, arm64Source] = await Promise.all([
    readFile(x64Path, 'utf8'),
    readFile(arm64Path, 'utf8'),
  ]);
  // One source for the floor: the same config that stamps LSMinimumSystemVersion
  // into the bundle, so the two cannot drift apart.
  const { mac } = createRequire(import.meta.url)('../electron-builder.config.cjs');
  await writeFile(
    outputPath,
    mergeMacUpdateManifests(x64Source, arm64Source, {
      minimumSystemVersion: mac?.minimumSystemVersion,
    }),
  );
}
