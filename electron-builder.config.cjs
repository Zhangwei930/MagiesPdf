/**
 * electron-builder configuration.
 *
 * Packaging targets mirror MagiesTerminal (MgTerminal/electron-builder.config.cjs)
 * so release assets, download pages and the R2 mirror stay consistent across products.
 *
 * Architecture is selected by CLI flags (`--x64` / `--arm64`), not hard-coded
 * multi-arch arrays on Windows/Linux — same as MagiesTerminal CI.
 *
 * @type {import('electron-builder').Configuration}
 */

function requestedArch() {
  return process.env.npm_config_arch || process.env.npm_config_target_arch || process.arch;
}

const { assertOfficeRuntime } = require('./scripts/officePackaging.cjs');

function builderArchName(arch) {
  if (typeof arch === 'string') return arch;
  return { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[arch] ?? String(arch);
}

module.exports = {
  appId: 'top.magies.pdf',
  productName: 'Magies Office',
  copyright: `Copyright © ${new Date().getFullYear()} JasonZhangDad`,

  /**
   * Artefact names follow the MagiesTerminal convention so the download page and
   * the R2 mirror can pattern-match releases from either product identically.
   */
  artifactName: 'MagiesPdf-${version}-${os}-${arch}.${ext}',

  directories: {
    output: 'release/${version}',
    buildResources: 'build',
  },

  // build/icon.{icns,ico,png} — generated from the MagiesPDF brand mark.
  icon: 'build/icon.png',

  files: [
    'electron/**/*',
    'dist/**/*',
    'dist-electron/**/*',
    'package.json',
    // Window/taskbar icon path used by electron/main.cjs at runtime.
    'build/icon.png',
    '!**/*.map',
    '!**/*.test.*',
  ],

  /**
   * MuPDF ships a WASM binary that it loads from disk at runtime via
   * `import.meta.url`. Inside an asar archive that path is not a real file, so
   * the module must stay unpacked or every tool fails on first use.
   */
  /**
   * PDFs open in MagiesPdf when the user *asks* for that — Open With, a drop on
   * the dock icon, or after they set it as the default themselves.
   *
   * The app deliberately does not claim the default handler on install. macOS
   * gets `role: Viewer` + `rank: Alternate`, which puts MagiesPdf in Open With
   * and leaves Preview (or whatever the user chose) as the default. On Windows
   * this registers a ProgID under OpenWithProgids, which likewise only adds an
   * entry to "Open with" — the default lives in UserChoice, which no installer
   * can set on Windows 10/11 anyway.
   */
  fileAssociations: [
    {
      ext: ['pdf'],
      name: 'PDF Document',
      description: 'Portable Document Format',
      mimeType: 'application/pdf',
      role: 'Viewer',
      rank: 'Alternate',
      isPackage: false,
    },
    {
      ext: ['doc', 'docx', 'odt', 'rtf'],
      name: 'Word Document',
      description: 'Word Processing Document',
      role: 'Editor',
      rank: 'Alternate',
      isPackage: false,
    },
    {
      ext: ['xls', 'xlsx', 'ods'],
      name: 'Spreadsheet',
      description: 'Spreadsheet Document',
      role: 'Editor',
      rank: 'Alternate',
      isPackage: false,
    },
    {
      ext: ['ppt', 'pptx', 'odp'],
      name: 'Presentation',
      description: 'Presentation Document',
      role: 'Editor',
      rank: 'Alternate',
      isPackage: false,
    },
  ],

  asar: true,
  asarUnpack: [
    'electron/mcp/**/*',
    'electron/office/uno_worker.py',
    'node_modules/@modelcontextprotocol/sdk/**/*',
    'node_modules/ajv/**/*',
    'node_modules/ajv-formats/**/*',
    'node_modules/fast-deep-equal/**/*',
    'node_modules/fast-uri/**/*',
    'node_modules/json-schema-traverse/**/*',
    'node_modules/mupdf/**',
    'node_modules/tesseract.js/**',
    'node_modules/tesseract.js-core/**',
    'node_modules/zod/**/*',
    'node_modules/zod-to-json-schema/**/*',
  ],

  extraResources: [
    {
      from: 'vendor/office-runtime/${os}-${arch}',
      to: 'office-runtime',
    },
    // The ONLYOFFICE engine is deliberately not shipped. Previews render
    // through the LibreOffice runtime above, which is already here and needs no
    // font manifest; bundling a second engine would add ~500 MB and a manifest
    // that only describes the build machine's fonts. `assertDocumentEngine` and
    // `electron/office/engine.cjs` stay for the editor work that will need it.
  ],

  beforePack: async (context) => {
    assertOfficeRuntime({
      projectRoot: __dirname,
      platform: context.electronPlatformName,
      arch: builderArchName(context.arch),
    });
  },

  mac: {
    icon: 'build/icon.icns',
    // Open-source builds: no paid Developer ID / notarization (same as MagiesTerminal).
    identity: null,
    notarize: false,
    category: 'public.app-category.productivity',
    darkModeSupport: true,
    target: ['dmg', 'zip'],
    // The PDF handler declared in `fileAssociations` is registered as an
    // alternate, so MagiesPdf appears in Open With without displacing whatever
    // the user already uses.
    extendInfo: {
      NSHumanReadableCopyright: `Copyright © ${new Date().getFullYear()} JasonZhangDad`,
    },
  },

  dmg: {
    title: '${productName}',
    artifactName: 'MagiesPdf-${version}-mac-${arch}.${ext}',
    iconSize: 100,
    iconTextSize: 12,
    window: {
      width: 540,
      height: 380,
    },
    contents: [
      { x: 140, y: 158 },
      { x: 400, y: 158, type: 'link', path: '/Applications' },
    ],
  },

  win: {
    icon: 'build/icon.ico',
    // Architecture selected by CLI (`--x64` / `--arm64`), matching MagiesTerminal.
    // Targets: NSIS installer + portable + zip (no-install environments).
    target: ['nsis', 'portable', 'zip'],
    // arm64 publishes on its own update channel so it cannot clobber x64 latest.yml.
    ...(requestedArch() === 'arm64'
      ? {
          publish: [
            {
              provider: 'github',
              owner: 'Zhangwei930',
              repo: 'MagiesPdf',
              releaseType: 'release',
              channel: 'latest-arm64',
            },
          ],
        }
      : {}),
  },

  portable: {
    artifactName: 'MagiesPdf-${version}-portable-${os}-${arch}.${ext}',
  },

  nsis: {
    artifactName: 'MagiesPdf-${version}-win-${arch}.${ext}',
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    shortcutName: 'Magies Office',
  },

  linux: {
    icon: 'build/icon.png',
    // Align with productName so desktop environments can match the running window.
    executableName: 'magies-office',
    // AppImage + deb are built on the native Linux release runner.
    target: ['AppImage', 'deb'],
    category: 'Office',
    maintainer: 'JasonZhangDad <470059464@qq.com>',
    desktop: {
      entry: {
        Name: 'Magies Office',
        Comment: 'Local-first Office and PDF workspace',
        Categories: 'Office;Utility;',
      },
    },
  },

  deb: {
    // gzip for broader distro compatibility (Deepin / older systems), same as MagiesTerminal.
    compression: 'gz',
  },

  rpm: {
    // Avoid xzmt (missing on some RHEL/Alma 8 builders).
    compression: 'gzip',
    fpm: [
      '--rpm-rpmbuild-define',
      '_build_id_links none',
      '--rpm-rpmbuild-define',
      '__os_install_post %{nil}',
    ],
  },

  /**
   * Releases go to a dedicated public repo, keeping the source repo free of
   * large binaries. Mainland-China users are served the same artefacts from the
   * Cloudflare/R2 mirror instead — see `electron/updater/releaseChannel.cjs`.
   */
  publish: [
    {
      provider: 'github',
      owner: 'Zhangwei930',
      repo: 'MagiesPdf',
      releaseType: 'release',
    },
  ],
};
