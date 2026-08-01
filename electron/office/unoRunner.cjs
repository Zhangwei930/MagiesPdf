'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fileSystem = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const UNO_TIMEOUT_MS = 120000;

function libreOfficePythonCandidates(soffice, platform = process.platform) {
  if (platform === 'win32') {
    const directory = path.win32.dirname(soffice);
    return [path.win32.join(directory, 'python.exe'), path.win32.join(directory, 'python3.exe')];
  }
  if (platform === 'darwin') {
    const contents = path.resolve(path.dirname(soffice), '..');
    return [path.join(contents, 'Resources', 'python')];
  }
  return [path.join(path.dirname(soffice), 'python'), '/usr/bin/python3'];
}

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveLibreOfficePython(soffice, {
  platform = process.platform,
  isExecutable = defaultIsExecutable,
} = {}) {
  const executable = libreOfficePythonCandidates(soffice, platform)
    .find((candidate) => isExecutable(candidate));
  if (!executable) {
    throw new Error('LibreOffice Python/UNO runtime is unavailable in this installation');
  }
  return executable;
}

function officeAcceptArgs(pipeName, profileUrl) {
  if (!/^magies_[A-Za-z0-9_]+$/.test(pipeName)) throw new Error('Invalid LibreOffice pipe name');
  if (!String(profileUrl).startsWith('file:')) throw new Error('Invalid LibreOffice profile URL');
  return [
    '--headless',
    '--invisible',
    '--nologo',
    '--nodefault',
    '--nolockcheck',
    '--nofirststartwizard',
    '--norestore',
    `-env:UserInstallation=${profileUrl}`,
    `--accept=pipe,name=${pipeName};urp;StarOffice.ComponentContext`,
  ];
}

function officeLaunch(soffice, args) {
  return { command: soffice, args };
}

function unpackedWorkerPath(candidate) {
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function defaultExecutePython(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const detail = String(stderr || '').trim().slice(0, 4000);
      reject(new Error(`LibreOffice UNO bridge failed: ${error.message}${detail ? `\n${detail}` : ''}`));
    });
  });
}

function pythonEnvironment(soffice, environment = process.env, platform = process.platform) {
  if (platform !== 'linux') return { ...environment };
  const program = path.dirname(soffice);
  return {
    ...environment,
    PYTHONPATH: [program, environment.PYTHONPATH].filter(Boolean).join(path.delimiter),
    LD_LIBRARY_PATH: [program, environment.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter),
    URE_BOOTSTRAP: `vnd.sun.star.pathname:${path.join(program, 'fundamentalrc')}`,
  };
}

function waitForOfficeExit(child, timeoutMs) {
  if (
    !child
    || (child.exitCode !== null && child.exitCode !== undefined)
    || typeof child.once !== 'function'
  ) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    child.once('error', finish);
  });
}

function createUnoRunner({
  createTemporaryDirectory = () => fileSystem.mkdtemp(path.join(os.tmpdir(), 'magies-office-uno-')),
  executePython = defaultExecutePython,
  randomId = crypto.randomUUID,
  resolvePython = resolveLibreOfficePython,
  spawnOffice = spawn,
  workerPath = unpackedWorkerPath(path.join(__dirname, 'uno_worker.py')),
  platform = process.platform,
  environment = process.env,
} = {}) {
  const run = async (request) => {
    if (!request || typeof request !== 'object' || !request.executable) {
      throw new Error('A LibreOffice executable and UNO request are required');
    }
    const { executable, signal, ...operation } = request;
    const pipeName = `magies_${String(randomId()).replace(/[^A-Za-z0-9_]/g, '_')}`;
    const workerRequest = { ...operation, pipeName };
    const encoded = JSON.stringify(workerRequest);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) {
      throw new Error('LibreOffice UNO request is too large');
    }

    const temporaryDirectory = await createTemporaryDirectory();
    const profileDirectory = path.join(temporaryDirectory, 'profile');
    const requestPath = path.join(temporaryDirectory, 'request.json');
    const resultPath = path.join(temporaryDirectory, 'result.json');
    await fileSystem.mkdir(profileDirectory, { recursive: true });
    await fileSystem.writeFile(requestPath, encoded, { mode: 0o600 });

    const python = resolvePython(executable, { platform });
    const launch = officeLaunch(
      executable,
      officeAcceptArgs(pipeName, pathToFileURL(profileDirectory).href),
      platform,
    );
    const office = spawnOffice(
      launch.command,
      launch.args,
      { stdio: 'ignore', windowsHide: true },
    );

    try {
      await executePython(
        python,
        [workerPath, requestPath, resultPath],
        {
          env: pythonEnvironment(executable, environment, platform),
          maxBuffer: MAX_RESULT_BYTES,
          timeout: UNO_TIMEOUT_MS,
          windowsHide: true,
          signal,
        },
      );
      const bytes = await fileSystem.readFile(resultPath);
      if (bytes.length > MAX_RESULT_BYTES) throw new Error('LibreOffice UNO result is too large');
      let payload;
      try {
        payload = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new Error('LibreOffice UNO bridge returned invalid JSON');
      }
      if (!payload?.ok) throw new Error(String(payload?.error || 'LibreOffice UNO operation failed'));
      return payload.result ?? {};
    } finally {
      await waitForOfficeExit(office, 1500);
      try {
        if (office.exitCode === null || office.exitCode === undefined) office.kill();
      } catch {
        // LibreOffice may already have exited after the document closed.
      }
      await waitForOfficeExit(office, 1500);
      await fileSystem.rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  };

  return { run };
}

let defaultRunner;

function runUnoOperation(request) {
  if (!defaultRunner) defaultRunner = createUnoRunner();
  return defaultRunner.run(request);
}

module.exports = {
  MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES,
  createUnoRunner,
  libreOfficePythonCandidates,
  officeAcceptArgs,
  officeLaunch,
  pythonEnvironment,
  resolveLibreOfficePython,
  runUnoOperation,
  unpackedWorkerPath,
  waitForOfficeExit,
};
