const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isOfficeDocumentPath } = require('./formats.cjs');

function libreOfficeCandidates(platform = process.platform, env = process.env) {
  switch (platform) {
    case 'darwin':
      return [
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        ...(env.HOME ? [`${env.HOME}/Applications/LibreOffice.app/Contents/MacOS/soffice`] : []),
      ];
    case 'win32':
      return [env.ProgramFiles, env['ProgramFiles(x86)']]
        .filter((root) => typeof root === 'string' && root !== '')
        .map((root) => `${root}/LibreOffice/program/soffice.exe`);
    default:
      return ['/usr/bin/libreoffice', '/usr/bin/soffice', '/snap/bin/libreoffice'];
  }
}

function bundledLibreOfficeExecutable(root, platform = process.platform) {
  const normalizedRoot = root.replace(/[\\/]$/, '');
  switch (platform) {
    case 'darwin':
      return `${normalizedRoot}/LibreOffice.app/Contents/MacOS/soffice`;
    case 'win32':
      return `${normalizedRoot}/program/soffice.exe`;
    default:
      return `${normalizedRoot}/program/soffice`;
  }
}

function officeRuntimeRoot({
  packaged = false,
  resourcesPath = process.resourcesPath ?? '',
  projectRoot = path.join(__dirname, '..', '..'),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (packaged) return path.join(resourcesPath, 'office-runtime');
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform;
  return path.join(projectRoot, 'vendor', 'office-runtime', `${os}-${arch}`);
}

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveLibreOfficeExecutable({
  bundledRoot = '',
  configured = '',
  packaged = false,
  platform = process.platform,
  env = process.env,
  isExecutable = defaultIsExecutable,
} = {}) {
  const bundled = bundledRoot ? bundledLibreOfficeExecutable(bundledRoot, platform) : '';
  const candidates = packaged
    ? [bundled]
    : [bundled, configured, ...libreOfficeCandidates(platform, env)];
  return candidates.find((candidate) => isExecutable(candidate)) ?? '';
}

function libreOfficeLaunchArgs(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('At least one Office document is required');
  }
  if (paths.some((candidate) => !isOfficeDocumentPath(candidate))) {
    throw new Error('LibreOffice received an unsupported document path');
  }
  return ['--nologo', '--nodefault', '--nofirststartwizard', '--norestore', ...paths];
}

function launchLibreOffice(executable, paths, spawnProcess = spawn, platform = process.platform) {
  if (!executable) throw new Error('LibreOffice is not configured or installed');
  const documentArgs = libreOfficeLaunchArgs(paths);
  const appMarker = '.app/Contents/MacOS/';
  const appMarkerIndex = executable.indexOf(appMarker);
  const command = platform === 'darwin' && appMarkerIndex >= 0 ? '/usr/bin/open' : executable;
  const args = command === '/usr/bin/open'
    ? ['-n', executable.slice(0, appMarkerIndex + 4), '--args', ...documentArgs]
    : documentArgs;
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

module.exports = {
  bundledLibreOfficeExecutable,
  launchLibreOffice,
  libreOfficeCandidates,
  libreOfficeLaunchArgs,
  officeRuntimeRoot,
  resolveLibreOfficeExecutable,
};
