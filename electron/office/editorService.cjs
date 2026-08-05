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

function createEditorService(deps) {
  const { sessions, host, listMedia, rememberPaths } = deps;

  return {
    /** Converts each document and makes it reachable by the editor. */
    async open(paths) {
      const opened = [];
      for (const sourcePath of paths) {
        const session = await sessions.open(sourcePath);
        const media = await listMedia(session.workDir);
        const { url } = await host.publish({
          id: session.id,
          workDir: session.workDir,
          media,
          title: session.name,
          documentType: session.editorType,
          fileType: (session.name.split('.').pop() ?? 'docx').toLowerCase(),
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
  };
}

module.exports = { createEditorService };
