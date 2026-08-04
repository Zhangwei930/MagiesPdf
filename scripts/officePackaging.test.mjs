import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  assertOfficeRuntime,
  officeRuntimeSource,
  assertDocumentEngine,
  documentEngineFilter,
  documentEngineSource,
} = require('./officePackaging.cjs');

describe('document engine packaging', () => {
  it('selects the engine matching the package target', () => {
    assert.equal(
      documentEngineSource('/repo', 'darwin', 'arm64'),
      '/repo/vendor/onlyoffice/mac-arm64',
    );
    assert.equal(documentEngineSource('/repo', 'win32', 'x64'), '/repo/vendor/onlyoffice/win-x64');
    assert.equal(documentEngineSource('/repo', 'linux', 'x64'), '/repo/vendor/onlyoffice/linux-x64');
  });

  /**
   * Without the engine an installed app looks fine until someone opens a Word
   * file, so packaging has to refuse rather than ship a build that cannot.
   */
  it('fails packaging when the converter is absent', () => {
    assert.throws(
      () => assertDocumentEngine({ projectRoot: '/repo', platform: 'darwin', arch: 'x64', exists: () => false }),
      /prepare:engine/,
    );
  });

  /**
   * The converter needs no font manifest for what this app asks of it —
   * converting between a document and the editor's binary, verified against
   * the real engine with no manifest at all. Requiring one would fail every
   * build for a file that is not shipped.
   */
  it('does not require the converter font manifest', () => {
    const onlyBrowserBuild = (candidate) => !candidate.includes('/editors/');
    assert.doesNotThrow(
      () => assertDocumentEngine({ projectRoot: '/repo', platform: 'darwin', arch: 'x64', exists: onlyBrowserBuild }),
    );
  });

  /**
   * The engine ships as two builds that are not interchangeable: the desktop
   * one the converter renders PDFs with, and the browser one the editor is
   * served from. A package with only the first opens documents read-only and
   * fails the moment anyone edits.
   */
  it('fails packaging when the browser build is absent', () => {
    const noBrowserBuild = (candidate) => !candidate.includes('/web/');
    assert.throws(
      () => assertDocumentEngine({ projectRoot: '/repo', platform: 'darwin', arch: 'x64', exists: noBrowserBuild }),
      /editor/i,
    );
  });

  it('accepts a complete engine', () => {
    assert.equal(
      assertDocumentEngine({ projectRoot: '/repo', platform: 'linux', arch: 'x64', exists: () => true }),
      '/repo/vendor/onlyoffice/linux-x64',
    );
  });
});

/**
 * The engine as downloaded is 1.8 GB, and most of that is never reached from
 * this app: help documentation in a dozen languages, the mobile and embedded
 * builds of each editor, and editors for formats this app does not open. What
 * is kept is what a document actually goes through.
 */
describe('what of the engine is packaged', () => {
  const filter = documentEngineFilter();
  /** Rules apply in order and the last one to match decides, as the builder does. */
  const kept = (file) => filter.reduce((verdict, rule) => {
    const negated = rule.startsWith('!');
    const pattern = negated ? rule.slice(1) : rule;
    return matches(pattern, file) ? !negated : verdict;
  }, false);

  /**
   * A minimal glob matcher, enough for the shapes electron-builder takes.
   * Everything is escaped first, so the only regex in the result is what a
   * glob metacharacter was turned into.
   */
  function matches(pattern, file) {
    const expression = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{([^}]*)\\\}/g, (all, options) => `(${options.split(',').join('|')})`)
      .split('**')
      .map((part) => part.replace(/\*/g, '[^/]*'))
      .join('.*');
    return new RegExp(`^${expression}$`).test(file);
  }

  it('keeps what a document is opened, laid out and saved with', () => {
    for (const file of [
      'converter/x2t',
      'converter/empty/en-US/new.docx',
      'web/sdkjs/word/sdk-all-min.js',
      'web/sdkjs/common/AllFonts.js',
      'web/fonts/LiberationSerif-Regular.ttf',
      'web/web-apps/apps/documenteditor/main/index.html',
      'web/web-apps/apps/api/documents/api.js.tpl',
      'web/web-apps/apps/documenteditor/main/locale/zh.json',
      'web/web-apps/apps/documenteditor/main/locale/en.json',
    ]) {
      assert.ok(kept(file), `${file} is needed to open a document`);
    }
  });

  it('leaves out what nothing here reaches', () => {
    for (const file of [
      'web/web-apps/apps/spreadsheeteditor/main/resources/help/en/images/big.gif',
      'web/web-apps/apps/documenteditor/mobile/index.html',
      'web/web-apps/apps/documenteditor/embed/index.html',
      'web/web-apps/apps/visioeditor/main/index.html',
      'converter/templates/JA/Forms/form.pdf',
      // The desktop build and the font data it needs exist for one thing:
      // rendering PDFs through the converter, which nothing here does — the
      // preview goes through the bundled LibreOffice, which needs no font
      // manifest and works on every platform. Shipping them would also ship
      // a manifest describing the build machine's fonts.
      'editors/sdkjs/word/sdk-all.js',
      'editors/web-apps/vendor/xregexp/xregexp-all-min.js',
      'fonts/AllFonts.js',
      'web/sdkjs/pdf/pdf.js',
      'web/web-apps/apps/documenteditor/main/locale/fr.json',
      // The locale rule re-includes rather than excludes, and its wildcard
      // reaches editors that are meant to be gone entirely.
      'web/web-apps/apps/visioeditor/main/locale/en.json',
    ]) {
      assert.ok(!kept(file), `${file} is packaged but never reached`);
    }
  });
});

describe('bundled Office packaging', () => {
  it('selects the runtime matching the package target', () => {
    assert.equal(
      officeRuntimeSource('/repo', 'darwin', 'arm64'),
      '/repo/vendor/office-runtime/mac-arm64',
    );
    assert.equal(
      officeRuntimeSource('/repo', 'win32', 'x64'),
      '/repo/vendor/office-runtime/win-x64',
    );
  });

  it('fails packaging when the bundled editor is absent', () => {
    assert.throws(
      () => assertOfficeRuntime({
        projectRoot: '/repo',
        platform: 'linux',
        arch: 'x64',
        isExecutable: () => false,
      }),
      /prepare:office-runtime/i,
    );
  });

  it('prepares every supported installer and does not publish a partial Linux ARM64 build', async () => {
    const packageJson = require('../package.json');
    const builderConfig = require('../electron-builder.config.cjs');
    for (const name of ['pack:mac', 'pack:mac-x64', 'pack:mac-arm64', 'pack:win-x64', 'pack:win-arm64', 'pack:linux-x64']) {
      assert.match(packageJson.scripts[name], /prepare:office-runtime/);
      assert.match(packageJson.scripts[name], /verify:office-package/);
    }
    assert.match(packageJson.scripts['pack:mac'], /--x64/);
    assert.match(packageJson.scripts['pack:mac'], /--arm64/);
    assert.deepEqual(builderConfig.mac.target, ['dmg', 'zip']);
    assert.equal(packageJson.scripts['pack:linux-arm64'], undefined);

    const releaseWorkflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    assert.doesNotMatch(releaseWorkflow, /linux-arm64/);
    assert.match(releaseWorkflow, /macos-15-intel/);
    assert.match(releaseWorkflow, /windows-11-arm/);
  });
});
