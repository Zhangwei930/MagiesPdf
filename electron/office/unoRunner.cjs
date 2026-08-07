'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fileSystem = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { withEngineLock } = require('./engineLock.cjs');

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const UNO_TIMEOUT_MS = 120000;
/**
 * Two retries, because the engine fails this way for two independent reasons
 * and one budget between them ran out on the second: an instance that never
 * accepted, followed by one that crashed, is not a document problem and should
 * not be reported as one.
 */
const ACCEPTOR_ATTEMPTS = 3;
/**
 * Failures of the engine rather than answers about the document.
 *
 * Two shapes, one remedy. LibreOffice intermittently starts without accepting
 * on the pipe it was given; and it intermittently dies mid-call — SIGSEGV
 * inside a UNO dispatch, which reaches the bridge as a disposed connection and
 * says nothing about what was being done at the time.
 */
const ENGINE_FAILED = /Unable to connect to LibreOffice|Binary URP bridge disposed|DisposedException/;

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

/**
 * Where LibreOffice puts the socket backing a named pipe.
 *
 * Not inside the user-installation directory, so tearing the profile down
 * leaves it behind: one file in /tmp per Office operation, for the life of the
 * machine, and LibreOffice takes longer to start the more of them it finds.
 * Windows named pipes have no filesystem entry, so there is nothing to remove.
 */
function officePipeSocketPath(pipeName, {
  platform = process.platform,
  pipeDirectory = '/tmp',
  uid,
} = {}) {
  if (platform === 'win32') return '';
  const owner = uid ?? (typeof process.getuid === 'function' ? process.getuid() : '');
  return path.join(pipeDirectory, `OSL_PIPE_${owner}_${pipeName}`);
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

/**
 * Whether the engine is still up.
 *
 * A child killed by a signal keeps `exitCode` null and reports `signalCode`
 * instead, so reading the exit code alone calls a killed LibreOffice running
 * and waits out the full timeout on a process that has already gone.
 */
function officeIsRunning(child) {
  if (!child) return false;
  const exited = (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
  return !exited;
}

function waitForOfficeExit(child, timeoutMs) {
  if (!officeIsRunning(child) || typeof child.once !== 'function') return Promise.resolve();
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

async function stopOffice(child, signal, timeoutMs) {
  if (!officeIsRunning(child)) return;
  try {
    child.kill(signal);
  } catch {
    // LibreOffice may already have exited after the document closed.
  }
  await waitForOfficeExit(child, timeoutMs);
}

function createUnoRunner({
  createTemporaryDirectory = () => fileSystem.mkdtemp(path.join(os.tmpdir(), 'magies-office-uno-')),
  executePython = defaultExecutePython,
  /** How long each stage of the shutdown waits before escalating. */
  officeExitTimeoutMs = 10000,
  randomId = crypto.randomUUID,
  resolvePython = resolveLibreOfficePython,
  /** Where the pipe socket lands; injected so the cleanup can be tested. */
  pipeDirectory = '/tmp',
  spawnOffice = spawn,
  workerPath = unpackedWorkerPath(path.join(__dirname, 'uno_worker.py')),
  platform = process.platform,
  environment = process.env,
  withLock = withEngineLock,
} = {}) {
  const execute = async (request) => {
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
      // The engine lock is released as soon as this returns, so what is waited
      // for here is the process being *gone*, not a fixed slice of time. The
      // worker asks the desktop to terminate, which is usually enough; ask
      // again, then insist. An instance that outlives this wait is one the next
      // operation collides with, and it reports `couldn't connect to pipe`.
      await waitForOfficeExit(office, officeExitTimeoutMs);
      await stopOffice(office, 'SIGTERM', officeExitTimeoutMs);
      await stopOffice(office, 'SIGKILL', officeExitTimeoutMs);
      // Only once it is gone: a live LibreOffice recreates its own socket.
      const socketPath = officePipeSocketPath(pipeName, { platform, pipeDirectory });
      if (socketPath) await fileSystem.rm(socketPath, { force: true });
      await fileSystem.rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  };

  /**
   * Serialised: a second LibreOffice while one is live never opens its
   * acceptor, and the caller sees `couldn't connect to pipe` instead of
   * anything that names the contention.
   */
  const run = async (request) => {
    if (!request || typeof request !== 'object' || !request.executable) {
      throw new Error('A LibreOffice executable and UNO request are required');
    }
    const { executable: _executable, signal: _signal, ...operation } = request;
    return withLock(async () => {
      let refused;
      for (let attempt = 0; attempt < ACCEPTOR_ATTEMPTS; attempt += 1) {
        try {
          return await execute(request);
        } catch (error) {
          // Nothing in the request causes either of these and nothing in the
          // profile clears them; an entirely fresh instance does. Anything else
          // is the engine's answer about this document, and repeating it would
          // double the wait and change nothing.
          if (!ENGINE_FAILED.test(String(error?.message))) throw error;
          refused = error;
          // A crash can land after the document was stored, and LibreOffice
          // refuses to write over a file that is already there — the retry
          // would fail on the wreckage of the attempt before it.
          if (operation.outputPath) {
            await fileSystem.rm(operation.outputPath, { force: true });
          }
        }
      }
      throw refused;
    });
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
  officePipeSocketPath,
  pythonEnvironment,
  resolveLibreOfficePython,
  runUnoOperation,
  unpackedWorkerPath,
  waitForOfficeExit,
};
