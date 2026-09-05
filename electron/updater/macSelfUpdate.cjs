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
 *   under its product name → check it is the version we asked for → clear
 *   quarantine → caller relaunches. Any failure rolls the original bundle back.
 *
 * Two things here are about how long the restart takes, because this app is
 * about 2 GB on disk once LibreOffice and the Office engine are counted:
 *
 * - **Nothing is synchronous.** `ditto` on a 777 MB zip is tens of seconds and
 *   `execFileSync` would spend all of it with the main process stopped: the
 *   window answers nothing, macOS draws a beachball, and the toast's spinner
 *   keeps turning because the renderer is a different process and does not
 *   know. Every command is awaited, and progress is reported as it goes.
 * - **The old bundle is not deleted here.** Removing ~2 GB is another ten or
 *   twenty seconds, and it is housekeeping — the update is already installed.
 *   It is renamed aside and `sweepStaleBackups` clears it on the next launch,
 *   so the restart never waits for a recursive delete.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile: nodeExecFile } = require('node:child_process');
const { promisify } = require('node:util');

const runCommand = promisify(nodeExecFile);

/** Suffix of the set-aside bundle; `sweepStaleBackups` is the only thing that reads it. */
const BACKUP_PATTERN = /\.app\.update-backup-\d+$/;

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
 * The version a bundle declares. `plutil` reads binary and XML plists alike;
 * a packaged Info.plist is binary.
 */
async function readBundleVersion(bundlePath, execFile) {
  const plist = path.join(bundlePath, 'Contents', 'Info.plist');
  const { stdout } = await execFile('plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    plist,
  ]);
  return String(stdout ?? '').trim() || null;
}

/**
 * Remove the bundles previous updates set aside, next to `bundlePath`.
 *
 * Best-effort and never fatal: a backup that cannot be removed costs disk
 * space, and refusing to start over it would be far worse. Returns how many
 * were removed.
 */
async function sweepStaleBackups(bundlePath, { log = console } = {}) {
  if (!bundlePath) return 0;
  const parentDir = path.dirname(bundlePath);
  let entries;
  try {
    entries = await fs.promises.readdir(parentDir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!BACKUP_PATTERN.test(entry)) continue;
    try {
      await fs.promises.rm(path.join(parentDir, entry), { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn?.('[macSelfUpdate] Failed to remove stale backup:', err?.message || err);
    }
  }
  return removed;
}

/**
 * Swap the installed bundle with the update contained in `zipPath`.
 * Throws with a user-presentable message on any failure; the original bundle
 * is always left in place when the swap cannot complete.
 *
 * @param {object} options
 * @param {string | null} options.zipPath - update zip downloaded by electron-updater
 * @param {string | null} options.bundlePath - currently installed .app bundle
 * @param {string | null} [options.expectedVersion] - refuse a bundle that is not this
 * @param {Function} [options.execFile] - injectable for tests; must return a promise
 * @param {(stage: string) => void} [options.onProgress]
 * @param {string} [options.tmpRoot] - staging dir root, defaults to os.tmpdir()
 * @param {{ warn: Function }} [options.log]
 * @returns {Promise<{ bundlePath: string, executablePath: string, backupPath: string }>}
 */
async function installMacUpdateFromZip({
  zipPath,
  bundlePath,
  expectedVersion = null,
  execFile = runCommand,
  onProgress = () => {},
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

  const stagingDir = await fs.promises.mkdtemp(path.join(tmpRoot, 'magiespdf-update-'));
  let backupPath = null;
  let installedBundlePath = null;
  let installedExecutablePath = null;
  try {
    // ditto preserves symlinks, permissions, and extended attributes — the
    // canonical way to unpack .app zips (plain unzip can corrupt frameworks).
    // This is most of the wait, so it is announced before it starts.
    onProgress('extracting');
    await execFile('ditto', ['-x', '-k', zipPath, stagingDir]);

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
    const executableRelativePath = path.relative(newAppPath, findAppExecutable(newAppPath));
    installedExecutablePath = path.join(installedBundlePath, executableRelativePath);

    onProgress('installing');
    backupPath = path.join(parentDir, `${path.basename(bundlePath)}.update-backup-${process.pid}`);
    await fs.promises.rename(bundlePath, backupPath);

    /** Put the original bundle back so the running install stays intact. */
    const rollback = async (cause) => {
      try {
        if (fs.existsSync(installedBundlePath)) {
          await fs.promises.rm(installedBundlePath, { recursive: true, force: true });
        }
        await fs.promises.rename(backupPath, bundlePath);
        backupPath = null;
      } catch (rollbackError) {
        const error = new Error(`Failed to restore the original app from ${backupPath}`, {
          cause,
        });
        error.code = 'MAC_UPDATE_ROLLBACK_FAILED';
        error.rollbackError = rollbackError;
        throw error;
      }
    };

    try {
      try {
        await fs.promises.rename(newAppPath, installedBundlePath);
      } catch (err) {
        if (err?.code !== 'EXDEV') throw err;
        // Staging dir is on a different volume — fall back to a copy.
        await execFile('ditto', [newAppPath, installedBundlePath]);
      }

      // What was just installed has to *be* the update. Without this a swap
      // that quietly produced the old version looks like a successful restart
      // that then offers the same update again, with nothing saying why.
      if (expectedVersion) {
        let installedVersion = null;
        try {
          installedVersion = await readBundleVersion(installedBundlePath, execFile);
        } catch (err) {
          log.warn?.('[macSelfUpdate] Could not read the installed version:', err?.message || err);
        }
        if (installedVersion && installedVersion !== expectedVersion) {
          throw new Error(
            `Update installed as ${installedVersion}, expected ${expectedVersion}. The original app was kept.`,
          );
        }
      }
    } catch (err) {
      await rollback(err);
      throw err;
    }

    // The zip was downloaded by this app, not a browser, so quarantine is not
    // expected — but clear it defensively or Gatekeeper would block the
    // relaunch of an unsigned bundle.
    onProgress('finishing');
    try {
      await execFile('xattr', ['-dr', 'com.apple.quarantine', installedBundlePath]);
    } catch (err) {
      log.warn?.('[macSelfUpdate] Failed to clear quarantine:', err?.message || err);
    }
  } finally {
    // The old bundle is deliberately left as `backupPath` — see the note at the
    // top. Only the staging directory goes, and after a successful rename it
    // holds nothing large.
    try {
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
    } catch (err) {
      log.warn?.('[macSelfUpdate] Failed to remove staging dir:', err?.message || err);
    }
  }

  return {
    bundlePath: installedBundlePath,
    executablePath: installedExecutablePath,
    backupPath,
  };
}

module.exports = {
  resolveMacBundlePath,
  installMacUpdateFromZip,
  sweepStaleBackups,
};
