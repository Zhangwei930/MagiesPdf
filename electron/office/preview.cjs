const path = require('node:path');
const { editorTypeFor } = require('./session.cjs');

/**
 * Renders an Office file into something the app's own viewer can show.
 *
 * This is what makes the suite one window. Opening a .docx used to hand the
 * file to a second application; now it is rendered to PDF here and arrives in
 * the renderer as bytes, so it becomes a tab beside every other document.
 *
 * What comes back is deliberately shaped like a picked file, with one
 * difference: `path` is empty and the source is under `origin`. The bytes are a
 * PDF and the source is not, so a tab that adopted that path would destroy the
 * user's document the first time anyone pressed ⌘S.
 */

const KIND_BY_EDITOR = new Map([
  ['word', 'word'],
  ['cell', 'sheet'],
  ['slide', 'slide'],
]);

function createOfficePreview(deps) {
  const { x2t, fs } = deps;

  async function renderOne(sourcePath) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
      throw new Error('An absolute document path is required');
    }
    const kind = KIND_BY_EDITOR.get(editorTypeFor(sourcePath));
    if (!kind) throw new Error(`Unsupported document format: ${sourcePath}`);

    const { pdfPath, workDir } = await x2t.toPdf(sourcePath);
    try {
      const bytes = await fs.readFile(pdfPath);
      return {
        // The document's own name. What the tab shows is a rendering of it,
        // but that is how it is shown, not what it is.
        name: path.basename(sourcePath),
        path: '',
        size: bytes.length,
        mime: 'application/pdf',
        bytes,
        origin: { path: sourcePath, kind },
      };
    } finally {
      // The render holds a copy of the user's document. Once the bytes are in
      // hand it has no reason to stay on disk — including when reading failed.
      await x2t.discard(workDir);
    }
  }

  return {
    async render(paths) {
      const rendered = [];
      for (const candidate of paths) {
        rendered.push(await renderOne(candidate));
      }
      return rendered;
    },
  };
}

module.exports = { createOfficePreview };
