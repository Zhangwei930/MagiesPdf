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

function createOfficeSessions(deps) {
  const { x2t, fs, uniqueId } = deps;
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
      return restoreTo(session, targetPath);
    },

    async close(id) {
      const session = get(id);
      sessions.delete(id);
      await x2t.discard(session.workDir);
      return { closed: id };
    },

    async closeAll() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((session) => x2t.discard(session.workDir)));
      return { closed: open.length };
    },
  };
}

module.exports = { createOfficeSessions, editorTypeFor };
