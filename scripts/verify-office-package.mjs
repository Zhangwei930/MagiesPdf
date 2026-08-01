import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LIBREOFFICE_VERSION } from './officeRuntime.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);

export function expectedMachine(platform, arch) {
  const machines = {
    darwin: { x64: 0x01000007, arm64: 0x0100000c },
    win32: { x64: 0x8664, arm64: 0xaa64 },
    linux: { x64: 62 },
  };
  const machine = machines[platform]?.[arch];
  if (machine === undefined) throw new Error(`Unsupported package architecture: ${platform}-${arch}`);
  return machine;
}

export function executableMachine(input, platform) {
  const bytes = Buffer.from(input);
  if (platform === 'darwin') {
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
      throw new Error('Bundled Office editor is not a 64-bit Mach-O executable');
    }
    return bytes.readUInt32LE(4);
  }
  if (platform === 'win32') {
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('Bundled Office editor is not a Windows executable');
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    if (bytes.length < peOffset + 6 || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
      throw new Error('Bundled Office editor has an invalid PE header');
    }
    return bytes.readUInt16LE(peOffset + 4);
  }
  if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error('Bundled Office editor is not an ELF executable');
  }
  return bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18);
}

export function assertExecutableArchitecture(bytes, platform, arch) {
  const actual = executableMachine(bytes, platform);
  const expected = expectedMachine(platform, arch);
  if (actual !== expected) {
    throw new Error(
      `Bundled Office editor architecture mismatch: expected ${arch} ` +
      `(0x${expected.toString(16)}), received 0x${actual.toString(16)})`,
    );
  }
}

export function hostCanRunTarget(
  targetPlatform,
  targetArch,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  return targetPlatform === hostPlatform && targetArch === hostArch;
}

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function isOfficeExecutable(candidate, platform) {
  const normalized = candidate.split(path.sep).join('/').toLowerCase();
  const suffix = platform === 'darwin'
    ? '/office-runtime/libreoffice.app/contents/macos/soffice'
    : `/office-runtime/program/${platform === 'win32' ? 'soffice.exe' : 'soffice'}`;
  return normalized.endsWith(suffix);
}

async function findOfficeExecutables(root, platform) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && isOfficeExecutable(candidate, platform)) matches.push(candidate);
    }
  }
  return matches;
}

function runtimeRootFor(executable) {
  const marker = `${path.sep}office-runtime${path.sep}`;
  const index = executable.indexOf(marker);
  return executable.slice(0, index + marker.length - 1);
}

async function verifyMetadata(executable) {
  const runtimeRoot = runtimeRootFor(executable);
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'runtime.json'), 'utf8'));
  if (manifest.version !== LIBREOFFICE_VERSION) {
    throw new Error(`Bundled Office manifest version is ${manifest.version}, expected ${LIBREOFFICE_VERSION}`);
  }
  const notice = await readFile(
    path.join(runtimeRoot, 'MAGIES-OFFICE-LIBREOFFICE-NOTICE.txt'),
    'utf8',
  );
  if (!notice.includes('MPL-2.0') || !notice.includes(`/libreoffice/src/${LIBREOFFICE_VERSION}/`)) {
    throw new Error('Bundled Office licence or source notice is incomplete');
  }
}

async function verifyPackage(root, platform, arch) {
  const candidates = await findOfficeExecutables(root, platform);
  const matching = [];
  for (const candidate of candidates) {
    const bytes = await readFile(candidate);
    if (executableMachine(bytes, platform) === expectedMachine(platform, arch)) matching.push(candidate);
  }
  if (matching.length === 0) {
    throw new Error(`No ${platform}-${arch} bundled Office executable was found under ${root}`);
  }

  for (const executable of matching) await verifyMetadata(executable);
  const executable = matching[0];
  if (hostCanRunTarget(platform, arch)) {
    const result = await execFileAsync(executable, ['--headless', '--version'], {
      timeout: 30000,
      windowsHide: true,
    });
    const versionOutput = `${result.stdout}\n${result.stderr}`;
    if (versionOutput.trim() && !versionOutput.includes('LibreOffice')) {
      throw new Error(`Bundled Office smoke test returned unexpected output: ${versionOutput.trim()}`);
    }
    console.log(`[office-package] Native launch passed: ${platform}-${arch}`);
  } else {
    console.log(`[office-package] Architecture and metadata passed; native launch skipped on ${process.platform}-${process.arch}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const root = path.resolve(argument('root', 'release'));
  const platform = argument('platform', process.platform);
  const arch = argument('arch', process.arch);
  await verifyPackage(root, platform, arch);
}
