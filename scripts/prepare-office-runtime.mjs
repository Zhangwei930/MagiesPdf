import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
} from 'node:fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  LIBREOFFICE_VERSION,
  officeRuntimeDirectory,
  officeRuntimeExecutable,
  officeRuntimeNotice,
  officeRuntimeSpec,
} from './officeRuntime.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function download(url, target) {
  const partial = `${target}.part`;
  await rm(partial, { force: true });
  const response = await globalThis.fetch(url, {
    headers: { 'user-agent': 'MagiesOffice-build/1.0' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download ${url}: HTTP ${response.status}`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await rename(partial, target);
  } catch (cause) {
    await rm(partial, { force: true });
    throw cause;
  }
}

async function downloadFromAny(urls, target) {
  const failures = [];
  for (const url of urls) {
    try {
      await download(url, target);
      return;
    } catch (cause) {
      failures.push(`${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  throw new Error(`Unable to download the Office runtime:\n${failures.join('\n')}`);
}

async function sha256(target) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifiedArchive(spec, cacheRoot) {
  const name = path.basename(new URL(spec.url).pathname);
  const archive = path.join(cacheRoot, name);
  await mkdir(cacheRoot, { recursive: true });
  if (!(await exists(archive))) await downloadFromAny([spec.url, ...spec.mirrors], archive);

  const actual = await sha256(archive);
  if (actual !== spec.sha256) {
    await rm(archive, { force: true });
    throw new Error(`Checksum mismatch for ${name}`);
  }
  return archive;
}

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findFirst(root, predicate) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (predicate(candidate)) return candidate;
    }
  }
  return '';
}

async function extractMac(archive, staged, workRoot) {
  const mount = path.join(workRoot, 'mount');
  await mkdir(mount);
  await run('hdiutil', ['attach', archive, '-nobrowse', '-readonly', '-mountpoint', mount]);
  try {
    await cp(path.join(mount, 'LibreOffice.app'), path.join(staged, 'LibreOffice.app'), {
      recursive: true,
      preserveTimestamps: true,
    });
  } finally {
    await run('hdiutil', ['detach', mount]);
  }
}

async function extractWindows(archive, staged, workRoot) {
  const extracted = path.join(workRoot, 'msi');
  await mkdir(extracted);
  await run('msiexec.exe', ['/a', archive, '/qn', `TARGETDIR=${extracted}`]);
  const soffice = await findFirst(
    extracted,
    (candidate) => path.basename(candidate).toLowerCase() === 'soffice.exe',
  );
  if (!soffice) throw new Error('The LibreOffice MSI did not contain soffice.exe');
  await cp(path.dirname(path.dirname(soffice)), staged, { recursive: true, preserveTimestamps: true });
}

async function extractLinux(archive, staged, workRoot) {
  const packages = path.join(workRoot, 'packages');
  const extracted = path.join(workRoot, 'deb-root');
  await mkdir(packages);
  await mkdir(extracted);
  await run('tar', ['-xzf', archive, '-C', packages]);

  const debs = [];
  const pending = [packages];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (candidate.endsWith('.deb')) debs.push(candidate);
    }
  }
  if (debs.length === 0) throw new Error('The LibreOffice archive contained no Debian packages');
  for (const deb of debs) await run('dpkg-deb', ['-x', deb, extracted]);

  const soffice = await findFirst(
    extracted,
    (candidate) => path.basename(candidate) === 'soffice' && path.basename(path.dirname(candidate)) === 'program',
  );
  if (!soffice) throw new Error('The LibreOffice packages did not contain program/soffice');
  await cp(path.dirname(path.dirname(soffice)), staged, { recursive: true, preserveTimestamps: true });
}

async function writeRuntimeMetadata(target, spec) {
  await writeFile(path.join(target, 'MAGIES-OFFICE-LIBREOFFICE-NOTICE.txt'), officeRuntimeNotice(spec));
  await writeFile(
    path.join(target, 'runtime.json'),
    `${JSON.stringify({ version: LIBREOFFICE_VERSION, source: spec.url }, null, 2)}\n`,
  );
}

async function prepareOfficeRuntime(platform, arch) {
  if (platform !== process.platform) {
    throw new Error(`Prepare ${platform}-${arch} on a ${platform} build runner, not ${process.platform}`);
  }

  const spec = officeRuntimeSpec(platform, arch);
  const target = path.join(projectRoot, 'vendor', 'office-runtime', officeRuntimeDirectory(platform, arch));
  const executable = officeRuntimeExecutable(target, platform);
  if (await exists(executable)) {
    await writeRuntimeMetadata(target, spec);
    console.log(`[office-runtime] LibreOffice ${LIBREOFFICE_VERSION} already prepared at ${target}`);
    return;
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const workRoot = await mkdtemp(path.join(parent, '.prepare-'));
  const staged = path.join(workRoot, 'runtime');
  await mkdir(staged);

  try {
    const archive = await verifiedArchive(spec, path.join(projectRoot, '.cache', 'office-runtime'));
    if (platform === 'darwin') await extractMac(archive, staged, workRoot);
    else if (platform === 'win32') await extractWindows(archive, staged, workRoot);
    else await extractLinux(archive, staged, workRoot);

    const stagedExecutable = officeRuntimeExecutable(staged, platform);
    await access(stagedExecutable, constants.F_OK);
    if (platform !== 'win32') await chmod(stagedExecutable, 0o755);
    await writeRuntimeMetadata(staged, spec);

    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
    console.log(`[office-runtime] Prepared LibreOffice ${LIBREOFFICE_VERSION} at ${target}`);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const platform = argument('platform', process.platform);
  const arch = argument('arch', process.arch);
  await prepareOfficeRuntime(platform, arch);
}
