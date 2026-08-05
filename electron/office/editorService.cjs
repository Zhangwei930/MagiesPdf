/**
 * Opening, saving and closing a document in the embedded editor.
 *
 * Two things have to agree about a document: the session that owns its work
 * directory, and the host that serves that directory to the editor. This joins
 * them, so nothing else has to know there are two.
 *
 * What the renderer gets back is shaped like a picked file, with one
 * difference: there are no bytes. They stay in the work directory, and the tab
 * holds only the session it can reach them through.
 */

const path = require('node:path');

function createEditorService(deps) {
  const { sessions, host, listMedia, rememberPaths, fs } = deps;

  return {
    /**
     * Converts each document and makes it reachable by the editor.
     * `uiTheme` is an ONLYOFFICE id (`theme-system` / `theme-white` / `theme-night`).
     */
    async open(paths, { uiTheme = 'theme-white' } = {}) {
      // Convert every path first (x2t is independent per work dir), then
      // publish. Parallel conversion is why opening two files is not 2× one.
      const prepared = await Promise.all(
        paths.map(async (sourcePath) => {
          const session = await sessions.open(sourcePath);
          const media = await listMedia(session.workDir);
          return { session, media };
        }),
      );

      const opened = [];
      for (const { session, media } of prepared) {
        const { url } = await host.publish({
          id: session.id,
          workDir: session.workDir,
          media,
          title: session.name,
          documentType: session.editorType,
          fileType: (session.name.split('.').pop() ?? 'docx').toLowerCase(),
          uiTheme,
        });
        opened.push({
          name: session.name,
          path: session.path,
          size: 0,
          mime: 'application/octet-stream',
          bytes: new Uint8Array(0),
          // editorType lets the shell create "the same kind" when the engine
          // asks for New — without it every new document would be Word.
          editor: { sessionId: session.id, url, editorType: session.editorType },
        });
      }
      // Recent documents used to be written only by the PDF-preview open path.
      // Opening in the editor is the real path now, so it has to remember too.
      if (typeof rememberPaths === 'function' && paths.length > 0) {
        rememberPaths(paths);
      }
      return opened;
    },

    /** Starts the editor host and returns static assets to cache in the renderer. */
    warm() {
      if (typeof host.warm !== 'function') return Promise.resolve({ origin: '', prefetch: [] });
      return host.warm();
    },

    focus(sessionId) {
      host.focus(sessionId);
    },

    /**
     * Writes the document the engine sent back, then converts it to the format
     * the file on disk is in.
     *
     * The order matters: converting before the bytes land would save whatever
     * the previous save left behind.
     */
    async save(sessionId, base64) {
      await sessions.writeEditorBin(sessionId, base64);
      return sessions.save(sessionId);
    },

    /**
     * Saves under another name, converting by the target's extension.
     *
     * The same order as `save`, and for the same reason: the document has to
     * come out of the engine before anything is written, or what lands is
     * whatever the last save left behind, missing every edit since.
     */
    async saveAs(sessionId, base64, targetPath) {
      await sessions.writeEditorBin(sessionId, base64);
      return sessions.saveAs(sessionId, targetPath);
    },

    /**
     * Stops serving the document before removing it.
     *
     * A closing editor can still have a request in flight; withdrawing first
     * turns that into a 404 rather than a read from a directory being deleted.
     */
    async close(sessionId) {
      host.withdraw(sessionId);
      await sessions.close(sessionId);
      return { closed: sessionId };
    },

    /**
     * Writes the file the engine already produced for "Save copy as".
     *
     * The engine may upload a finished document (PDF, OOXML zip) or still the
     * editor binary (spreadsheet downloads go that way). Finished OOXML lands
     * as-is; binaries are converted by extension without moving the open tab.
     *
     * PDF is never taken from the engine. Its DoctRenderer embeds Japanese
     * system faces for Chinese text, so every PDF export is re-rendered with
     * LibreOffice from the current Editor.bin (or from the uploaded binary).
     */
    async writeExport(sessionId, targetPath) {
      if (typeof targetPath !== 'string' || !targetPath) {
        throw new Error('An absolute target path is required');
      }
      if (typeof fs?.writeFile !== 'function') {
        throw new Error('A file system is required to write an export');
      }
      const taken = host.consumeExport(sessionId);
      if (isPdfPath(targetPath)) {
        if (looksLikePdf(taken.bytes)) {
          // Discard the engine's PDF and render from the session binary.
          return sessions.exportPdf(sessionId, targetPath);
        }
        return sessions.exportTo(sessionId, taken.bytes, targetPath);
      }
      if (looksLikeFinishedDocument(taken.bytes)) {
        await fs.writeFile(targetPath, taken.bytes);
        return { path: targetPath, name: path.basename(targetPath) };
      }
      return sessions.exportTo(sessionId, taken.bytes, targetPath);
    },
  };
}

function isPdfPath(candidate) {
  return path.extname(String(candidate)).toLowerCase() === '.pdf';
}

function looksLikePdf(bytes) {
  return Boolean(bytes && bytes.length >= 5 && bytes.slice(0, 5).toString('ascii') === '%PDF-');
}

/** PDF (`%PDF`) or OOXML/ZIP (`PK`) — already the file the user asked for. */
function looksLikeFinishedDocument(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (looksLikePdf(bytes)) return true;
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

module.exports = { createEditorService, looksLikeFinishedDocument };

