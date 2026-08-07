const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { withEngineLock } = require('./engineLock.cjs');
const { editorTypeFor } = require('./session.cjs');

/**
 * Renders an Office document to PDF with the bundled LibreOffice, headless.
 *
 * This is what a Word, Sheet or Slide tab actually shows. It deliberately
 * exposes the same two calls as the x2t converter — `toPdf` and `discard` — so
 * the preview service does not know or care which engine produced the page.
 *
 * Headless conversion is not the same thing as launching the editor: no window
 * appears, nothing is left running, and the process exits when the page is
 * written. That distinction is the whole point of the single window.
 */

const CONVERT_TIMEOUT_MS = 120000;

function createLibreOfficeRenderer(deps) {
  const { executable, tempRoot, fs, run, uniqueId, withLock = withEngineLock } = deps;

  return {
    async toPdf(sourcePath) {
      if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
        throw new Error('An absolute document path is required');
      }
      if (editorTypeFor(sourcePath) === '') {
        throw new Error(`Unsupported document format: ${sourcePath}`);
      }
      if (!executable) {
        throw new Error('The bundled Office renderer is not available');
      }

      const workDir = path.join(tempRoot, uniqueId());
      await fs.mkdir(workDir, { recursive: true });

      // LibreOffice locks its user profile, so a shared one turns two documents
      // opening at once into a failure. Each conversion gets its own, inside
      // the work directory that is about to be thrown away anyway.
      const profile = pathToFileURL(path.join(workDir, 'profile')).href;
      // Serialised with every other engine call: a second LibreOffice while
      // one is live fails to start, and the error names none of that.
      const result = await withLock(() => run(
        executable,
        [
          '--headless',
          '--norestore',
          '--nolockcheck',
          '--nologo',
          '--nodefault',
          `-env:UserInstallation=${profile}`,
          '--convert-to',
          'pdf',
          '--outdir',
          workDir,
          sourcePath,
        ],
        { timeout: CONVERT_TIMEOUT_MS },
      ));
      if (result.code !== 0) {
        throw new Error(`LibreOffice failed with exit ${result.code}: ${result.stderr ?? ''}`.trim());
      }

      // A zero exit does not promise a file: an unreadable document leaves the
      // directory empty, and the tab would open blank instead of saying why.
      const pdfPath = path.join(workDir, `${path.basename(sourcePath).replace(/\.[^.]+$/, '')}.pdf`);
      try {
        await fs.access(pdfPath);
      } catch {
        throw new Error(`LibreOffice produced no PDF for ${sourcePath}`);
      }
      return { pdfPath, workDir };
    },

    /** Mirrors the converter's guard: never remove anything outside temp. */
    async discard(workDir) {
      const resolved = path.resolve(String(workDir));
      const root = path.resolve(tempRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('Refusing to remove a directory outside the renderer temp root');
      }
      await fs.rm(resolved, { recursive: true, force: true });
    },
  };
}

module.exports = { createLibreOfficeRenderer };
