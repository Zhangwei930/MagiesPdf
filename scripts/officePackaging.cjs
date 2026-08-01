const fs = require('node:fs');
const path = require('node:path');

function runtimeOs(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return platform;
}

function officeRuntimeSource(projectRoot, platform, arch) {
  return path.join(projectRoot, 'vendor', 'office-runtime', `${runtimeOs(platform)}-${arch}`);
}

function officeRuntimeExecutable(root, platform) {
  if (platform === 'darwin') {
    return path.join(root, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice');
  }
  return path.join(root, 'program', platform === 'win32' ? 'soffice.exe' : 'soffice');
}

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function assertOfficeRuntime({
  projectRoot,
  platform,
  arch,
  isExecutable = defaultIsExecutable,
}) {
  const source = officeRuntimeSource(projectRoot, platform, arch);
  const executable = officeRuntimeExecutable(source, platform);
  if (!isExecutable(executable)) {
    throw new Error(
      `Bundled Office runtime is missing for ${platform}-${arch}. ` +
      `Run npm run prepare:office-runtime -- --platform=${platform} --arch=${arch}`,
    );
  }
  return source;
}

module.exports = {
  assertOfficeRuntime,
  officeRuntimeSource,
};
