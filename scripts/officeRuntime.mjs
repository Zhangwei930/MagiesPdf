export const LIBREOFFICE_VERSION = '26.2.5';

const DOWNLOAD_ROOT = `https://download.documentfoundation.org/libreoffice/stable/${LIBREOFFICE_VERSION}`;
const SOURCE_URL = `https://download.documentfoundation.org/libreoffice/src/${LIBREOFFICE_VERSION}/`;
const LICENSE_URL = 'https://www.libreoffice.org/licenses/';

function runtimeSpec(archive, url, sha256) {
  const relative = url.slice(DOWNLOAD_ROOT.length + 1);
  return {
    archive,
    url,
    sha256,
    version: LIBREOFFICE_VERSION,
    mirrors: [
      `https://ftp.osuosl.org/pub/tdf/libreoffice/stable/${LIBREOFFICE_VERSION}/${relative}`,
      `https://mirror.fcix.net/tdf/libreoffice/stable/${LIBREOFFICE_VERSION}/${relative}`,
    ],
  };
}

export function officeRuntimeSpec(platform, arch) {
  if (platform === 'darwin' && arch === 'x64') {
    return runtimeSpec(
      'dmg',
      `${DOWNLOAD_ROOT}/mac/x86_64/LibreOffice_${LIBREOFFICE_VERSION}_MacOS_x86-64.dmg`,
      'e26180298685274b54aa7fe6e1101c65465a372f457a6748ebd642720811db36',
    );
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return runtimeSpec(
      'dmg',
      `${DOWNLOAD_ROOT}/mac/aarch64/LibreOffice_${LIBREOFFICE_VERSION}_MacOS_aarch64.dmg`,
      'c99fb4fe574437fc4cb820a4ca15271bca325920861f7139858b36d7f9df78ad',
    );
  }
  if (platform === 'win32' && arch === 'x64') {
    return runtimeSpec(
      'msi',
      `${DOWNLOAD_ROOT}/win/x86_64/LibreOffice_${LIBREOFFICE_VERSION}_Win_x86-64.msi`,
      'f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9',
    );
  }
  if (platform === 'win32' && arch === 'arm64') {
    return runtimeSpec(
      'msi',
      `${DOWNLOAD_ROOT}/win/aarch64/LibreOffice_${LIBREOFFICE_VERSION}_Win_aarch64.msi`,
      '48e99bba813c65a823b86a9fe8c0746a415f3d0e9459255f81f745f58fd353aa',
    );
  }
  if (platform === 'linux' && arch === 'x64') {
    return runtimeSpec(
      'tar.gz',
      `${DOWNLOAD_ROOT}/deb/x86_64/LibreOffice_${LIBREOFFICE_VERSION}_Linux_x86-64_deb.tar.gz`,
      '2f03bfb2ac9f33ea7c77331b4b7a23300fb0ed7443566046bf8b5bc51c1bed1e',
    );
  }
  if (platform === 'linux' && arch === 'arm64') {
    throw new Error(`An official LibreOffice ${LIBREOFFICE_VERSION} Linux ARM64 runtime is not published`);
  }
  throw new Error(`Unsupported Office runtime target: ${platform}-${arch}`);
}

export function officeRuntimeDirectory(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform;
  officeRuntimeSpec(platform, arch);
  return `${os}-${arch}`;
}

export function officeRuntimeExecutable(root, platform) {
  const normalizedRoot = root.replace(/[\\/]$/, '');
  if (platform === 'darwin') {
    return `${normalizedRoot}/LibreOffice.app/Contents/MacOS/soffice`;
  }
  if (platform === 'win32') return `${normalizedRoot}/program/soffice.exe`;
  return `${normalizedRoot}/program/soffice`;
}

export function officeRuntimeNotice(spec) {
  return `LibreOffice ${spec.version} bundled runtime

This installer includes an unmodified LibreOffice runtime downloaded from:
${spec.url}

LibreOffice is licensed under the Mozilla Public License 2.0 (MPL-2.0) and additional
third-party licences. Licence information: ${LICENSE_URL}

Corresponding LibreOffice source code: ${SOURCE_URL}
`;
}
