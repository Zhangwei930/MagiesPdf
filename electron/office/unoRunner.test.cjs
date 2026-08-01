'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const {
  createUnoRunner,
  libreOfficePythonCandidates,
  officeAcceptArgs,
  officeLaunch,
  pythonEnvironment,
  resolveLibreOfficePython,
  unpackedWorkerPath,
  waitForOfficeExit,
} = require('./unoRunner.cjs');

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-office-uno-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('LibreOffice UNO runtime resolution', () => {
  it('derives the bundled Python executable beside LibreOffice on each platform', () => {
    assert.deepEqual(
      libreOfficePythonCandidates('/runtime/LibreOffice.app/Contents/MacOS/soffice', 'darwin'),
      ['/runtime/LibreOffice.app/Contents/Resources/python'],
    );
    assert.deepEqual(
      libreOfficePythonCandidates('C:\\runtime\\program\\soffice.exe', 'win32'),
      ['C:\\runtime\\program\\python.exe', 'C:\\runtime\\program\\python3.exe'],
    );
    assert.deepEqual(
      libreOfficePythonCandidates('/runtime/program/soffice', 'linux'),
      ['/runtime/program/python', '/usr/bin/python3'],
    );
  });

  it('selects the first executable Python candidate and fails loudly otherwise', () => {
    assert.equal(resolveLibreOfficePython('/runtime/program/soffice', {
      platform: 'linux',
      isExecutable: (candidate) => candidate === '/usr/bin/python3',
    }), '/usr/bin/python3');
    assert.throws(
      () => resolveLibreOfficePython('/runtime/program/soffice', {
        platform: 'linux',
        isExecutable: () => false,
      }),
      /Python\/UNO runtime is unavailable/,
    );
  });

  it('checks executable permission when no probe is injected', async () => {
    const root = await temporaryDirectory();
    const python = path.join(root, 'python');
    await fs.writeFile(python, '');
    await fs.chmod(python, 0o755);

    assert.equal(
      resolveLibreOfficePython(path.join(root, 'soffice'), { platform: 'linux' }),
      python,
    );
  });

  it('uses an isolated profile and local named pipe without opening a TCP port', () => {
    const args = officeAcceptArgs('magies_test_pipe', 'file:///tmp/profile');
    assert.ok(args.includes('--headless'));
    assert.ok(args.includes('-env:UserInstallation=file:///tmp/profile'));
    assert.ok(args.includes('--accept=pipe,name=magies_test_pipe;urp;StarOffice.ComponentContext'));
    assert.equal(args.some((argument) => argument.includes('socket,')), false);
  });

  it('rejects malformed pipe names and non-file profile URLs', () => {
    assert.throws(
      () => officeAcceptArgs('not-a-pipe', 'file:///tmp/profile'),
      /Invalid LibreOffice pipe name/,
    );
    assert.throws(
      () => officeAcceptArgs('magies_valid', 'https://example.com/profile'),
      /Invalid LibreOffice profile URL/,
    );
  });

  it('launches the macOS app through LaunchServices and other platforms directly', () => {
    const acceptArgs = ['--headless', '--accept=pipe,name=magies_test;urp;StarOffice.ComponentContext'];
    assert.deepEqual(
      officeLaunch('/runtime/LibreOffice.app/Contents/MacOS/soffice', acceptArgs, 'darwin'),
      {
        command: '/usr/bin/open',
        args: ['-n', '-W', '/runtime/LibreOffice.app', '--args', ...acceptArgs],
      },
    );
    assert.deepEqual(
      officeLaunch('/runtime/program/soffice', acceptArgs, 'linux'),
      { command: '/runtime/program/soffice', args: acceptArgs },
    );
  });

  it('maps an asar worker path to its unpacked package location', () => {
    assert.equal(
      unpackedWorkerPath('/Applications/Magies Office.app/Contents/Resources/app.asar/electron/office/uno_worker.py'),
      '/Applications/Magies Office.app/Contents/Resources/app.asar.unpacked/electron/office/uno_worker.py',
    );
  });

  it('configures bundled UNO libraries only on Linux', () => {
    assert.deepEqual(
      pythonEnvironment('/runtime/program/soffice', { KEEP: 'yes' }, 'darwin'),
      { KEEP: 'yes' },
    );
    assert.deepEqual(
      pythonEnvironment(
        '/runtime/program/soffice',
        { KEEP: 'yes', PYTHONPATH: '/existing/python', LD_LIBRARY_PATH: '/existing/lib' },
        'linux',
      ),
      {
        KEEP: 'yes',
        PYTHONPATH: `/runtime/program${path.delimiter}/existing/python`,
        LD_LIBRARY_PATH: `/runtime/program${path.delimiter}/existing/lib`,
        URE_BOOTSTRAP: 'vnd.sun.star.pathname:/runtime/program/fundamentalrc',
      },
    );
  });

  it('waits for LibreOffice to exit and skips children that already stopped', async () => {
    const running = new EventEmitter();
    running.exitCode = null;
    const waited = waitForOfficeExit(running, 1000);
    setImmediate(() => running.emit('exit'));
    await waited;

    await waitForOfficeExit({ exitCode: 0 }, 1000);
  });
});

describe('createUnoRunner', () => {
  it('requires an executable before creating temporary state', async () => {
    let created = false;
    const runner = createUnoRunner({
      createTemporaryDirectory: async () => {
        created = true;
        return temporaryDirectory();
      },
    });

    await assert.rejects(() => runner.run({ operation: 'word_read' }), /executable and UNO request/);
    assert.equal(created, false);
  });

  it('runs the default subprocess bridge with bounded output', async () => {
    const root = await temporaryDirectory();
    const workerPath = path.join(root, 'bridge.cjs');
    await fs.writeFile(
      workerPath,
      "require('node:fs').writeFileSync(process.argv[3], JSON.stringify({ ok: true, result: { text: 'Subprocess' } }));",
    );
    const runner = createUnoRunner({
      createTemporaryDirectory: async () => path.join(root, 'session'),
      randomId: () => 'subprocess',
      resolvePython: () => process.execPath,
      workerPath,
      spawnOffice: () => ({ kill() {} }),
    });

    assert.deepEqual(await runner.run({
      executable: '/office/soffice', operation: 'word_read', inputPath: '/workspace/Letter.docx',
    }), { text: 'Subprocess' });
  });

  it('writes a bounded request, runs the Python bridge, parses the result, and cleans up', async () => {
    const root = await temporaryDirectory();
    const calls = [];
    let killed = false;
    const runner = createUnoRunner({
      createTemporaryDirectory: async () => path.join(root, 'session'),
      randomId: () => 'abc-123',
      resolvePython: () => '/office/python',
      workerPath: '/app/uno_worker.py',
      spawnOffice: (executable, args, options) => {
        calls.push({ type: 'office', executable, args, options });
        return { kill: () => { killed = true; } };
      },
      executePython: async (executable, args, options) => {
        calls.push({ type: 'python', executable, args, options });
        const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
        assert.equal(request.operation, 'word_read');
        assert.equal(request.pipeName, 'magies_abc_123');
        await fs.writeFile(args[2], JSON.stringify({ ok: true, result: { text: 'Hello' } }));
      },
    });

    const result = await runner.run({
      executable: '/office/soffice',
      operation: 'word_read',
      inputPath: '/workspace/Letter.docx',
    });

    assert.deepEqual(result, { text: 'Hello' });
    assert.equal(calls[0].type, 'office');
    assert.equal(calls[1].executable, '/office/python');
    assert.equal(killed, true);
    await assert.rejects(() => fs.access(path.join(root, 'session')), /ENOENT/);
  });

  it('surfaces structured Python errors and still terminates LibreOffice', async () => {
    const root = await temporaryDirectory();
    let killed = false;
    const runner = createUnoRunner({
      createTemporaryDirectory: async () => path.join(root, 'session'),
      randomId: () => 'failure',
      resolvePython: () => '/office/python',
      workerPath: '/app/uno_worker.py',
      spawnOffice: () => ({ kill: () => { killed = true; } }),
      executePython: async (_executable, args) => {
        await fs.writeFile(args[2], JSON.stringify({ ok: false, error: 'Document is password protected' }));
      },
    });

    await assert.rejects(() => runner.run({
      executable: '/office/soffice', operation: 'word_read', inputPath: '/workspace/Locked.docx',
    }), /Document is password protected/);
    assert.equal(killed, true);
  });

  it('rejects invalid bridge JSON and still terminates LibreOffice', async () => {
    const root = await temporaryDirectory();
    let killed = false;
    const runner = createUnoRunner({
      createTemporaryDirectory: async () => path.join(root, 'session'),
      randomId: () => 'invalid_json',
      resolvePython: () => '/office/python',
      workerPath: '/app/uno_worker.py',
      spawnOffice: () => ({ kill: () => { killed = true; } }),
      executePython: async (_executable, args) => {
        await fs.writeFile(args[2], '{not-json');
      },
    });

    await assert.rejects(() => runner.run({
      executable: '/office/soffice', operation: 'word_read', inputPath: '/workspace/Letter.docx',
    }), /invalid JSON/);
    assert.equal(killed, true);
  });

  it('rejects oversized requests before starting LibreOffice', async () => {
    let started = false;
    const runner = createUnoRunner({
      createTemporaryDirectory: temporaryDirectory,
      resolvePython: () => '/office/python',
      workerPath: '/app/uno_worker.py',
      spawnOffice: () => {
        started = true;
        return { kill() {} };
      },
      executePython: async () => {},
    });

    await assert.rejects(() => runner.run({
      executable: '/office/soffice',
      operation: 'excel_write',
      values: [['x'.repeat(1024 * 1024 + 1)]],
    }), /request is too large/);
    assert.equal(started, false);
  });
});
