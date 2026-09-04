const path = require('node:path');

/**
 * An open Office document, from the main process's point of view.
 *
 * The renderer never holds document bytes for an Office file the way it does
 * for a PDF. What it holds is a session id; the bytes live in a work directory
 * here, as the `Editor.bin` the engine actually edits. That split is what lets
 * several documents be open as tabs without keeping several copies of a large
 * file in renderer memory.
 *
 * The lifecycle is: `open` converts the document in, the editor pushes its
 * edits back with `writeEditorBin`, `save` converts them out, and `close`
 * removes the work directory. Nothing else may write into that directory.
 */

/** The editor id web-apps expects for each document kind. */
const EDITOR_TYPES = new Map([
  ['.docx', 'word'],
  ['.doc', 'word'],
  ['.odt', 'word'],
  ['.rtf', 'word'],
  ['.xlsx', 'cell'],
  ['.xls', 'cell'],
  ['.ods', 'cell'],
  ['.pptx', 'slide'],
  ['.ppt', 'slide'],
  ['.odp', 'slide'],
]);

function editorTypeFor(candidate) {
  return EDITOR_TYPES.get(path.extname(String(candidate)).toLowerCase()) ?? '';
}

/** What crosses the IPC boundary — never the work directory's contents. */
function describe(session) {
  return {
    id: session.id,
    path: session.path,
    name: session.name,
    editorType: session.editorType,
    modified: session.modified,
    binPath: session.binPath,
    workDir: session.workDir,
  };
}

function isPdfPath(candidate) {
  return path.extname(String(candidate)).toLowerCase() === '.pdf';
}

/**
 * Native document extension for a session — what LibreOffice must open.
 *
 * PDF export goes through the bundled LibreOffice, not the ONLYOFFICE
 * converter: DoctRenderer falls back to Japanese system faces for Chinese
 * text and produces garbled glyphs. LibreOffice embeds real CJK fonts.
 */
function nativeSourceExt(session) {
  const ext = path.extname(session.path).toLowerCase();
  return editorTypeFor(session.path) ? ext : '.docx';
}

function createOfficeSessions(deps) {
  const { x2t, fs, uniqueId, pdfRenderer = null } = deps;
  const sessions = new Map();

  function get(id) {
    const session = sessions.get(id);
    if (!session) throw new Error(`Unknown Office session: ${id}`);
    return session;
  }

  async function restoreTo(session, targetPath) {
    if (editorTypeFor(targetPath) === '') {
      throw new Error(`Unsupported document format: ${targetPath}`);
    }
    await x2t.fromEditorFormat(session.binPath, targetPath);
    session.path = targetPath;
    session.name = path.basename(targetPath);
    session.modified = false;
    return describe(session);
  }

  /**
   * Editor.bin → native Office file → LibreOffice PDF.
   *
   * Does not move the open tab: exporting a PDF is a snapshot, not a Save As
   * into a format the editor can keep editing.
   */
  async function renderPdf(session, binPath, targetPath) {
    if (!pdfRenderer) {
      throw new Error('PDF export requires the bundled LibreOffice renderer');
    }
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
      throw new Error('An absolute target path is required');
    }
    const intermediate = path.join(session.workDir, `pdf-export${nativeSourceExt(session)}`);
    await x2t.fromEditorFormat(binPath, intermediate);
    const { pdfPath, workDir } = await pdfRenderer.toPdf(intermediate);
    try {
      await fs.copyFile(pdfPath, targetPath);
    } finally {
      await pdfRenderer.discard(workDir);
    }
    return { path: targetPath, name: path.basename(targetPath) };
  }

  return {
    async open(sourcePath) {
      const editorType = editorTypeFor(sourcePath);
      if (editorType === '') throw new Error(`Unsupported document format: ${sourcePath}`);

      const { binPath, workDir } = await x2t.toEditorFormat(sourcePath);
      const session = {
        id: uniqueId(),
        path: sourcePath,
        name: path.basename(sourcePath),
        editorType,
        modified: false,
        binPath,
        workDir,
      };
      sessions.set(session.id, session);
      return describe(session);
    },

    get(id) {
      return describe(get(id));
    },

    list() {
      return [...sessions.values()].map(describe);
    },

    setModified(id, modified) {
      const session = get(id);
      session.modified = Boolean(modified);
      return describe(session);
    },

    /** The engine hands back base64; it lands in the session's own bin only. */
    async writeEditorBin(id, base64) {
      const session = get(id);
      await fs.writeFile(session.binPath, Buffer.from(String(base64), 'base64'));
      return describe(session);
    },

    async save(id) {
      const session = get(id);
      return restoreTo(session, session.path);
    },

    async saveAs(id, targetPath) {
      const session = get(id);
      if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
        throw new Error('An absolute target path is required');
      }
      // PDF is not an editor format — write a snapshot and keep the tab on the
      // document it can still edit. Moving the path to .pdf would leave the
      // next ⌘S trying to round-trip through a format the suite cannot open.
      if (isPdfPath(targetPath)) {
        await renderPdf(session, session.binPath, targetPath);
        // Named so the renderer can tell this apart from a save: the document
        // itself was not written, so its unsaved state has to survive.
        return { ...describe(session), exportedTo: targetPath };
      }
      return restoreTo(session, targetPath);
    },

    /**
     * Converts editor-binary bytes to a document file without moving the open
     * session. Used by "Save copy as", which must not rewrite the tab's path.
     *
     * PDF is special: it is rendered with LibreOffice so CJK text embeds real
     * Chinese fonts rather than the Japanese faces DoctRenderer picks.
     */
    async exportTo(id, bytes, targetPath) {
      const session = get(id);
      if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
        throw new Error('An absolute target path is required');
      }
      const tempBin = path.join(session.workDir, 'Export.bin');
      await fs.writeFile(tempBin, Buffer.from(bytes));
      if (isPdfPath(targetPath)) {
        return renderPdf(session, tempBin, targetPath);
      }
      await x2t.fromEditorFormat(tempBin, targetPath);
      return { path: targetPath, name: path.basename(targetPath) };
    },

    /**
     * PDF snapshot from the session's current Editor.bin via LibreOffice.
     * Used when "Save copy as PDF" delivered a finished (and unusable) OO PDF.
     */
    async exportPdf(id, targetPath) {
      const session = get(id);
      return renderPdf(session, session.binPath, targetPath);
    },

    async close(id) {
      const session = get(id);
      sessions.delete(id);
      await x2t.discard(session.workDir);
      return { closed: id };
    },

    /**
     * Every open session, on the way out.
     *
     * allSettled rather than all: this is the last chance to remove these
     * directories, and one that is busy or unreadable must not leave the rest
     * of the user's documents sitting in temp beside it.
     */
    async closeAll() {
      const open = [...sessions.values()];
      sessions.clear();
      const outcomes = await Promise.allSettled(
        open.map((session) => x2t.discard(session.workDir)),
      );
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          console.warn('[office] failed to discard a work directory:', outcome.reason);
        }
      }
      return { closed: open.length };
    },
  };
}

module.exports = { createOfficeSessions, editorTypeFor };
