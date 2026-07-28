const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveMacBundlePath,
  installMacUpdateFromZip,
} = require('./macSelfUpdate.cjs');

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Create a fake .app bundle whose Contents/MacOS/<name> holds `marker`. */
function writeFakeAppBundle(bundlePath, marker) {
  const macosDir = path.join(bundlePath, 'Contents', 'MacOS');
  fs.mkdirSync(macosDir, { recursive: true });
  fs.writeFileSync(path.join(macosDir, 'MagiesPdf'), marker);
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
  const fakeExecFileSync = (cmd, args) => {
    execCalls.push([cmd, ...args]);
    if (cmd === 'ditto' && args[0] === '-x') {
      // Simulate extraction: create the new .app inside the staging dir.
      const stagingDir = args[3];
      writeFakeAppBundle(path.join(stagingDir, 'MagiesPdf.app'), 'new-version');
    }
  };

  await installMacUpdateFromZip({
    zipPath,
    bundlePath,
    execFileSync: fakeExecFileSync,
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

  // No backup bundle or staging dir left behind next to the app.
  const leftovers = fs.readdirSync(root).filter((name) => name !== 'MagiesPdf.app' && name !== 'update.zip');
  assert.deepEqual(leftovers, [], `no leftovers expected, got: ${JSON.stringify(leftovers)}`);
});

test('installMacUpdateFromZip restores the original bundle when extraction yields no app', async (t) => {
  const root = makeTempDir(t, 'magiespdf-mac-update-');
  const bundlePath = path.join(root, 'MagiesPdf.app');
  writeFakeAppBundle(bundlePath, 'old-version');

  const zipPath = path.join(root, 'update.zip');
  fs.writeFileSync(zipPath, 'fake-zip-bytes');

  // ditto "succeeds" but produces no .app (corrupt archive).
  const fakeExecFileSync = () => {};

  await assert.rejects(
    installMacUpdateFromZip({
      zipPath,
      bundlePath,
      execFileSync: fakeExecFileSync,
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
      execFileSync: () => {},
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
      execFileSync: () => {},
      tmpRoot: root,
    }),
    /downloaded/i,
  );
});
