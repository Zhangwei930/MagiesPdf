/**
 * macOS self-update installer for unsigned builds.
 *
 * Squirrel.Mac (electron-updater's macOS install path) refuses apps without a
 * Developer ID signature, and MagiesPdf releases are intentionally unsigned.
 * electron-updater is still used for check + download — with
 * autoInstallOnAppQuit=false, MacUpdater never hands the download to Squirrel —
 * so the zip on disk is already sha512-verified against latest-mac.yml. This
 * module replaces only the install step:
 *
 *   extract zip (ditto) → rename current .app aside → install the new .app
 *   under its product name → clear quarantine → caller relaunches. Any failure
 *   rolls the original bundle back.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

/**
 * Derive the .app bundle path from the running executable
 * (<bundle>.app/Contents/MacOS/<binary>). Returns null when the executable is
 * not inside an app bundle (e.g. `npm run dev`).
 */
function resolveMacBundlePath(exePath) {
  if (!exePath) return null;
  const macosDir = path.dirname(exePath);
  const contentsDir = path.dirname(macosDir);
  const bundlePath = path.dirname(contentsDir);
  if (
    path.basename(macosDir) !== 'MacOS' ||
    path.basename(contentsDir) !== 'Contents' ||
    !bundlePath.endsWith('.app')
  ) {
    return null;
  }
  return bundlePath;
}

/** Find the first *.app directory (with a Contents/MacOS dir) inside `dir`. */
function findAppBundle(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.app')) continue;
    const candidate = path.join(dir, entry);
    if (fs.existsSync(path.join(candidate, 'Contents', 'MacOS'))) {
      return candidate;
    }
  }
  return null;
}

/** Find the packaged executable so the caller can relaunch from its new path. */
function findAppExecutable(bundlePath) {
  const macosDir = path.join(bundlePath, 'Contents', 'MacOS');
  const executable = fs
    .readdirSync(macosDir, { withFileTypes: true })
    .find((entry) => entry.isFile());
  if (!executable) {
    throw new Error('Update app bundle contains no executable.');
  }
  return path.join(macosDir, executable.name);
}

/**
 * Swap the installed bundle with the update contained in `zipPath`.
 * Throws with a user-presentable message on any failure; the original bundle
 * is always left in place when the swap cannot complete.
 *
 * @param {object} options
 * @param {string | null} options.zipPath - update zip downloaded by electron-updater
 * @param {string | null} options.bundlePath - currently installed .app bundle
 * @param {Function} [options.execFileSync] - injectable for tests
 * @param {string} [options.tmpRoot] - staging dir root, defaults to os.tmpdir()
 * @param {{ warn: Function }} [options.log]
 * @returns {Promise<{ bundlePath: string, executablePath: string }>}
 */
async function installMacUpdateFromZip({
  zipPath,
  bundlePath,
  execFileSync = nodeExecFileSync,
  tmpRoot = os.tmpdir(),
  log = console,
}) {
  if (!zipPath) {
    throw new Error('No downloaded update found. Download the update first.');
  }
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Downloaded update zip is missing: ${zipPath}`);
  }
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    throw new Error('Not running from an installed .app bundle.');
  }
  const parentDir = path.dirname(bundlePath);
  // Throws EACCES when the install location isn't writable (e.g. /Applications
  // owned by another user) — surface that before touching anything.
  fs.accessSync(parentDir, fs.constants.W_OK);

  const stagingDir = fs.mkdtempSync(path.join(tmpRoot, 'magiespdf-update-'));
  let backupPath = null;
  let installSucceeded = false;
  let installedBundlePath = null;
  let installedExecutablePath = null;
  try {
    // ditto preserves symlinks, permissions, and extended attributes — the
    // canonical way to unpack .app zips (plain unzip can corrupt frameworks).
    execFileSync('ditto', ['-x', '-k', zipPath, stagingDir]);

    const newAppPath = findAppBundle(stagingDir);
    if (!newAppPath) {
      throw new Error('Update archive contains no .app bundle.');
    }

    installedBundlePath = path.join(parentDir, path.basename(newAppPath));
    if (installedBundlePath !== bundlePath && fs.existsSync(installedBundlePath)) {
      const error = new Error(`Updated app destination already exists: ${installedBundlePath}`);
      error.code = 'MAC_UPDATE_DESTINATION_EXISTS';
      throw error;
    }
    const executableRelativePath = path.relative(
      newAppPath,
      findAppExecutable(newAppPath),
    );
    installedExecutablePath = path.join(installedBundlePath, executableRelativePath);

    backupPath = path.join(parentDir, `${path.basename(bundlePath)}.update-backup-${process.pid}`);
    fs.renameSync(bundlePath, backupPath);
    try {
      try {
        fs.renameSync(newAppPath, installedBundlePath);
      } catch (err) {
        if (err?.code !== 'EXDEV') throw err;
        // Staging dir is on a different volume — fall back to a copy.
        execFileSync('ditto', [newAppPath, installedBundlePath]);
      }
    } catch (err) {
      // Put the original bundle back so the running install stays intact.
      try {
        if (fs.existsSync(installedBundlePath)) {
          fs.rmSync(installedBundlePath, { recursive: true, force: true });
        }
        fs.renameSync(backupPath, bundlePath);
        backupPath = null;
      } catch (rollbackError) {
        const error = new Error(`Failed to restore the original app from ${backupPath}`, {
          cause: err,
        });
        error.code = 'MAC_UPDATE_ROLLBACK_FAILED';
        error.rollbackError = rollbackError;
        throw error;
      }
      throw err;
    }
    installSucceeded = true;

    // The zip was downloaded by this app, not a browser, so quarantine is not
    // expected — but clear it defensively or Gatekeeper would block the
    // relaunch of an unsigned bundle.
    try {
      execFileSync('xattr', ['-dr', 'com.apple.quarantine', installedBundlePath]);
    } catch (err) {
      log.warn?.('[macSelfUpdate] Failed to clear quarantine:', err?.message || err);
    }
  } finally {
    // On success backupPath is the OLD bundle; on rollback it was reset to
    // null after restoring, so this never deletes the live app.
    if (installSucceeded && backupPath) {
      try {
        fs.rmSync(backupPath, { recursive: true, force: true });
      } catch (err) {
        log.warn?.('[macSelfUpdate] Failed to remove backup bundle:', err?.message || err);
      }
    }
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (err) {
      log.warn?.('[macSelfUpdate] Failed to remove staging dir:', err?.message || err);
    }
  }

  return {
    bundlePath: installedBundlePath,
    executablePath: installedExecutablePath,
  };
}

module.exports = {
  resolveMacBundlePath,
  installMacUpdateFromZip,
};
