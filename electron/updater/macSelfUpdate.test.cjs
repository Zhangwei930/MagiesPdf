const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveMacBundlePath,
  installMacUpdateFromZip,
  sweepStaleBackups,
} = require('./macSelfUpdate.cjs');

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Create a fake .app bundle whose Contents/MacOS/<name> holds `marker`. */
function writeFakeAppBundle(bundlePath, marker, executableName = 'MagiesPdf') {
  const macosDir = path.join(bundlePath, 'Contents', 'MacOS');
  fs.mkdirSync(macosDir, { recursive: true });
  fs.writeFileSync(path.join(macosDir, executableName), marker);
}

test('resolveMacBundlePath derives the .app bundle from the executable path', () => {
  assert.equal(
    resolveMacBundlePath('/Applications/MagiesPdf.app/Contents/MacOS/MagiesPdf'),
    '/Applications/MagiesPdf.app',
  );
});

test('resolveMacBundlePath rejects executables outside a .app bundle', () => {
  assert.equal(resolveMacBundlePath('/usr/local/bin/magiespdf'), null);
  assert.equal(resolveMacBundlePath(''), null);
});

test('installMacUpdateFromZip swaps the bundle, clears quarantine, and cleans up', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');

  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  const execCalls = [];
  const fakeExecFile = (cmd, args) => {
    execCalls.push([cmd, ...args]);
    if (cmd === 'ditto' && args[0] === '-x') {
      // Simulate extraction: create the new .app inside the staging dir.
      const stagingDir = args[3];
      writeFakeAppBundle(path.join(stagingDir, 'MagiesPdf.app'), 'new-version');
    }
  };

  const installed = await installMacUpdateFromZip({
    zipPath,
    bundlePath,
    execFile: fakeExecFile,
    tmpRoot: root,
  });

  const swapped = fs.readFileSync(
    path.join(bundlePath, 'Contents', 'MacOS', 'MagiesPdf'),
    'utf8',
  );
  assert.equal(swapped, 'new-version');

  // Quarantine cleared on the swapped bundle.
  assert.ok(
    execCalls.some(
      (call) => call[0] === 'xattr' && call.includes('com.apple.quarantine') && call.includes(bundlePath),
    ),
    `xattr must clear quarantine, got: ${JSON.stringify(execCalls)}`,
  );

  // The old bundle is left aside on purpose: deleting 2 GB takes long enough
  // to be felt as a hang, and the restart must not wait for it. What must not
  // be left is the staging directory.
  const leftovers = fs
    .readdirSync(root)
    .filter((name) => name !== 'MagiesPdf.app' && name !== 'update.zip');
  assert.deepEqual(leftovers, [path.basename(installed.backupPath)], `got: ${JSON.stringify(leftovers)}`);
  assert.match(installed.backupPath, /MagiesPdf\.app\.update-backup-\d+$/);
});

test('installMacUpdateFromZip migrates a legacy bundle to the product name', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const legacyBundlePath = path.join(root, 'MagiesPdf.app');
  const productBundlePath = path.join(root, 'Magies Office.app');
  writeFakeAppBundle(legacyBundlePath, 'old-version');

  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  const execCalls = [];
  const fakeExecFile = (cmd, args) => {
    execCalls.push([cmd, ...args]);
    if (cmd === 'ditto' && args[0] === '-x') {
      writeFakeAppBundle(
        path.join(args[3], 'Magies Office.app'),
        'new-version',
        'Magies Office',
      );
    }
  };

  const installed = await installMacUpdateFromZip({
    zipPath,
    bundlePath: legacyBundlePath,
    execFile: fakeExecFile,
    tmpRoot: root,
  });

  assert.equal(installed.bundlePath, productBundlePath);
  assert.equal(
    installed.executablePath,
    path.join(productBundlePath, 'Contents', 'MacOS', 'Magies Office'),
  );
  assert.equal(fs.existsSync(legacyBundlePath), false);
  assert.equal(
    fs.readFileSync(path.join(productBundlePath, 'Contents', 'MacOS', 'Magies Office'), 'utf8'),
    'new-version',
  );
  assert.ok(
    execCalls.some((call) => call[0] === 'xattr' && call.includes(productBundlePath)),
    `xattr must target the renamed bundle, got: ${JSON.stringify(execCalls)}`,
  );
});

test('installMacUpdateFromZip does not overwrite an existing product-named bundle', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const legacyBundlePath = path.join(root, 'MagiesPdf.app');
  const productBundlePath = path.join(root, 'Magies Office.app');
  writeFakeAppBundle(legacyBundlePath, 'legacy-version');
  writeFakeAppBundle(productBundlePath, 'existing-version', 'Magies Office');

  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  await assert.rejects(
    installMacUpdateFromZip({
      zipPath,
      bundlePath: legacyBundlePath,
      execFile(cmd, args) {
        if (cmd === 'ditto' && args[0] === '-x') {
          writeFakeAppBundle(
            path.join(args[3], 'Magies Office.app'),
            'new-version',
            'Magies Office',
          );
        }
      },
      tmpRoot: root,
    }),
    /already exists/i,
  );

  assert.equal(
    fs.readFileSync(path.join(legacyBundlePath, 'Contents', 'MacOS', 'MagiesPdf'), 'utf8'),
    'legacy-version',
  );
  assert.equal(
    fs.readFileSync(path.join(productBundlePath, 'Contents', 'MacOS', 'Magies Office'), 'utf8'),
    'existing-version',
  );
});

test('installMacUpdateFromZip restores the original bundle when extraction yields no app', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');

  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  // ditto "succeeds" but produces no .app (corrupt archive).
  const fakeExecFile = () => {};

  await assert.rejects(
    installMacUpdateFromZip({
      zipPath,
      bundlePath,
      execFile: fakeExecFile,
      tmpRoot: root,
    }),
    /no \.app bundle/i,
  );

  // Original bundle must still be in place and intact.
  const content = fs.readFileSync(
    path.join(bundlePath, 'Contents', 'MacOS', 'MagiesPdf'),
    'utf8',
  );
  assert.equal(content, 'old-version');
});

test('installMacUpdateFromZip fails fast when the downloaded zip is missing', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');

  await assert.rejects(
    installMacUpdateFromZip({
      zipPath: path.join(root, 'missing.zip'),
      bundlePath,
      execFile: () => {},
      tmpRoot: root,
    }),
    /zip/i,
  );
});

test('installMacUpdateFromZip fails fast when no update was downloaded', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');

  await assert.rejects(
    installMacUpdateFromZip({
      zipPath: null,
      bundlePath,
      execFile: () => {},
      tmpRoot: root,
    }),
    /downloaded/i,
  );
});

/**
 * Everything below is about the restart taking tens of seconds.
 *
 * The install used to run `ditto`, `xattr` and a recursive delete of the old
 * ~2 GB bundle synchronously, on the main process. The window stopped
 * answering the OS for the whole of it — a beachball, while the toast's
 * spinner (which lives in the renderer, a different process) kept turning as
 * if something were going fine.
 */

test('installMacUpdateFromZip never blocks: every command is awaited', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');
  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  let ranOnALaterTick = false;
  // A command that only finishes on a later tick, the way a real one does.
  const asyncExecFile = async (cmd, args) => {
    await new Promise((resolve) => setImmediate(resolve));
    ranOnALaterTick = true;
    if (cmd === 'ditto' && args[0] === '-x') {
      writeFakeAppBundle(path.join(args[3], 'MagiesPdf.app'), 'new-version');
    }
    return { stdout: '', stderr: '' };
  };

  await installMacUpdateFromZip({
    zipPath,
    bundlePath,
    execFile: asyncExecFile,
    tmpRoot: root,
  });

  assert.equal(ranOnALaterTick, true);
  assert.equal(
    fs.readFileSync(path.join(bundlePath, 'Contents', 'MacOS', 'MagiesPdf'), 'utf8'),
    'new-version',
  );
});

test('installMacUpdateFromZip reports what it is doing', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');
  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  const stages = [];
  await installMacUpdateFromZip({
    zipPath,
    bundlePath,
    execFile: (cmd, args) => {
      if (cmd === 'ditto' && args[0] === '-x') {
        writeFakeAppBundle(path.join(args[3], 'MagiesPdf.app'), 'new-version');
      }
      return { stdout: '', stderr: '' };
    },
    tmpRoot: root,
    onProgress: (stage) => stages.push(stage),
  });

  // Unpacking 777 MB is most of the wait, so it has to be the first thing said.
  assert.equal(stages[0], 'extracting');
  assert.ok(stages.includes('installing'), `got: ${JSON.stringify(stages)}`);
});

/**
 * The symptom this catches: the app restarts, still reports the old version,
 * and offers the same update again — with nothing anywhere saying the swap
 * did not take.
 */
test('installMacUpdateFromZip rolls back when the installed bundle is the wrong version', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');
  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  await assert.rejects(
    installMacUpdateFromZip({
      zipPath,
      bundlePath,
      expectedVersion: '3.3.2',
      execFile: (cmd, args) => {
        if (cmd === 'ditto' && args[0] === '-x') {
          writeFakeAppBundle(path.join(args[3], 'MagiesPdf.app'), 'new-version');
        }
        if (cmd === 'plutil') return { stdout: '3.2.2\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      tmpRoot: root,
    }),
    /3\.2\.2/,
  );

  assert.equal(
    fs.readFileSync(path.join(bundlePath, 'Contents', 'MacOS', 'MagiesPdf'), 'utf8'),
    'old-version',
    'the working install must survive a bad update',
  );
});

test('installMacUpdateFromZip accepts a bundle whose version is the expected one', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');
  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  await installMacUpdateFromZip({
    zipPath,
    bundlePath,
    expectedVersion: '3.3.2',
    execFile: (cmd, args) => {
      if (cmd === 'ditto' && args[0] === '-x') {
        writeFakeAppBundle(path.join(args[3], 'MagiesPdf.app'), 'new-version');
      }
      if (cmd === 'plutil') return { stdout: '3.3.2\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    tmpRoot: root,
  });

  assert.equal(
    fs.readFileSync(path.join(bundlePath, 'Contents', 'MacOS', 'MagiesPdf'), 'utf8'),
    'new-version',
  );
});

/** A machine without `plutil` must still get its update. */
test('installMacUpdateFromZip installs anyway when the version cannot be read', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');
  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  const warnings = [];
  await installMacUpdateFromZip({
    zipPath,
    bundlePath,
    expectedVersion: '3.3.2',
    execFile: (cmd, args) => {
      if (cmd === 'ditto' && args[0] === '-x') {
        writeFakeAppBundle(path.join(args[3], 'MagiesPdf.app'), 'new-version');
      }
      if (cmd === 'plutil') throw new Error('plutil: command not found');
      return { stdout: '', stderr: '' };
    },
    tmpRoot: root,
    log: { warn: (...args) => warnings.push(args.join(' ')) },
  });

  assert.equal(
    fs.readFileSync(path.join(bundlePath, 'Contents', 'MacOS', 'MagiesPdf'), 'utf8'),
    'new-version',
  );
  assert.ok(warnings.some((line) => /version/i.test(line)), `got: ${JSON.stringify(warnings)}`);
});

test('sweepStaleBackups removes the bundles a past update left aside', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'Magies Office.app');
  writeFakeAppBundle(bundlePath, 'current', 'Magies Office');
  writeFakeAppBundle(path.join(root, 'Magies Office.app.update-backup-123'), 'old', 'Magies Office');
  writeFakeAppBundle(path.join(root, 'Magies Office.app.update-backup-456'), 'older', 'Magies Office');
  // Neighbours that are none of its business.
  writeFakeAppBundle(path.join(root, 'Some Other.app'), 'unrelated', 'Some Other');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'keep me');

  assert.equal(await sweepStaleBackups(bundlePath), 2);

  assert.deepEqual(
    fs.readdirSync(root).sort(),
    ['Magies Office.app', 'Some Other.app', 'notes.txt'],
  );
});

/**
 * The sweep runs a recursive delete in whatever directory the app is installed
 * in — /Applications, for most people. Matching the suffix alone meant it
 * would happily remove `Some Other.app.update-backup-123`, which is not ours
 * to delete.
 */
test('sweepStaleBackups only removes backups of the bundle it was given', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'Magies Office.app');
  writeFakeAppBundle(bundlePath, 'current', 'Magies Office');
  writeFakeAppBundle(path.join(root, 'Magies Office.app.update-backup-1'), 'ours', 'Magies Office');
  writeFakeAppBundle(path.join(root, 'Some Other.app.update-backup-2'), 'theirs', 'Some Other');

  assert.equal(await sweepStaleBackups(bundlePath), 1);

  assert.deepEqual(
    fs.readdirSync(root).sort(),
    ['Magies Office.app', 'Some Other.app.update-backup-2'],
  );
});

/** A bundle name is a file name, and file names may contain regex characters. */
test('sweepStaleBackups treats the bundle name as a name, not a pattern', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'M+g(e).app');
  writeFakeAppBundle(bundlePath, 'current', 'M');
  writeFakeAppBundle(path.join(root, 'M+g(e).app.update-backup-1'), 'ours', 'M');
  writeFakeAppBundle(path.join(root, 'MXgXeX.app.update-backup-2'), 'not ours', 'M');

  assert.equal(await sweepStaleBackups(bundlePath), 1);
  assert.ok(fs.existsSync(path.join(root, 'MXgXeX.app.update-backup-2')));
});

test('sweepStaleBackups is quiet when there is nothing to sweep', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'Magies Office.app');
  writeFakeAppBundle(bundlePath, 'current', 'Magies Office');

  assert.equal(await sweepStaleBackups(bundlePath), 0);
  assert.equal(await sweepStaleBackups(null), 0);
});
