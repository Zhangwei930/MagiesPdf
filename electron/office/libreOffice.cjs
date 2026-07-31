const fs = require('node:fs');
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

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveLibreOfficeExecutable({
  configured = '',
  platform = process.platform,
  env = process.env,
  isExecutable = defaultIsExecutable,
} = {}) {
  const candidates = [configured, ...libreOfficeCandidates(platform, env)].filter(Boolean);
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

function launchLibreOffice(executable, paths, spawnProcess = spawn) {
  if (!executable) throw new Error('LibreOffice is not configured or installed');
  const child = spawnProcess(executable, libreOfficeLaunchArgs(paths), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

module.exports = {
  launchLibreOffice,
  libreOfficeCandidates,
  libreOfficeLaunchArgs,
  resolveLibreOfficeExecutable,
};
