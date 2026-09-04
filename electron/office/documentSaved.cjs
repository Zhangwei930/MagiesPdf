'use strict';

/**
 * What happens when the engine posts a document back — the save itself.
 *
 * It lives here rather than inline in the IPC wiring because the failing half
 * is the half that matters and could not be tested there. A save fails for
 * ordinary reasons — a full disk, a file that went read-only underneath, a
 * converter that quit — and when it does, two things have to happen: the
 * renderer hears about it, so the tab keeps its unsaved state and can say so;
 * and the request still fails, so the engine's own error path runs instead of
 * it being told the document is safely on disk.
 *
 * Reporting to the renderer without rethrowing would be worse than either.
 */
function createDocumentSavedHandler({
  takeSaveAsTarget,
  save,
  saveAs,
  rememberRecent,
  notify,
}) {
  return async function onDocumentSaved(sessionId, document) {
    // A save-as asked where it should go before triggering this; taking the
    // target here is what keeps the original untouched.
    const target = takeSaveAsTarget(sessionId);
    const base64 = document.toString('base64');

    let saved;
    try {
      saved = target ? await saveAs(sessionId, base64, target) : await save(sessionId, base64);
    } catch (cause) {
      notify('office:editorSaveFailed', {
        sessionId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }

    // The tab has to adopt path/name after Save As, or the title and the next
    // ⌘S still point at the original file.
    if (saved?.path) rememberRecent([saved.path]);
    notify('office:editorSaved', {
      sessionId,
      path: saved?.path,
      name: saved?.name,
    });
  };
}

module.exports = { createDocumentSavedHandler };
