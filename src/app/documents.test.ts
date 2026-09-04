import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HISTORY_BYTE_BUDGET,
  HISTORY_LIMIT,
  applyEdit,
  applyEngineSaved,
  canRedo,
  canUndo,
  closeDocument,
  createDocument,
  isDirty,
  markSaved,
  nextActiveId,
  officeCreateKind,
  normalizeDocumentPath,
  setPathCaseSensitivity,
  openDocument,
  partitionOpenPaths,
  redo,
  replaceDocument,
  saveAsName,
  saveTarget,
  setEngineModified,
  undo,
  type DocumentState,
} from './documents.ts';
import type { PickedFile } from './bridge.ts';

const bytes = (fill: number, size = 4): Uint8Array => new Uint8Array(size).fill(fill);

const picked = (name: string, path: string, fill = 1): PickedFile => ({
  name,
  path,
  size: 4,
  mime: 'application/pdf',
  bytes: bytes(fill),
});

describe('createDocument', () => {
  it('starts clean, with nothing to undo', () => {
    const doc = createDocument(picked('a.pdf', '/docs/a.pdf'));
    assert.equal(doc.name, 'a.pdf');
    assert.equal(doc.path, '/docs/a.pdf');
    assert.equal(canUndo(doc), false);
    assert.equal(canRedo(doc), false);
    assert.equal(isDirty(doc), false);
  });

  it('gives every document its own id, even for the same file', () => {
    const a = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const b = createDocument(picked('a.pdf', '/docs/a.pdf'));
    assert.notEqual(a.id, b.id);
  });

  it('treats a newly created document with no path as unsaved', () => {
    const doc = createDocument(picked('untitled.pdf', ''));
    assert.equal(isDirty(doc), true);
  });
});

describe('applyEdit / undo / redo', () => {
  const start = createDocument(picked('a.pdf', '/docs/a.pdf', 1));

  it('replaces the bytes and makes the edit undoable', () => {
    const edited = applyEdit(start, bytes(2));
    assert.deepEqual(edited.bytes, bytes(2));
    assert.equal(canUndo(edited), true);
    assert.equal(isDirty(edited), true);
  });

  it('walks back to the previous bytes and forward again', () => {
    const edited = applyEdit(start, bytes(2));
    const back = undo(edited);
    assert.deepEqual(back.bytes, bytes(1));
    assert.equal(canRedo(back), true);

    const forward = redo(back);
    assert.deepEqual(forward.bytes, bytes(2));
    assert.equal(canRedo(forward), false);
  });

  it('drops the redo branch once a new edit is made', () => {
    const back = undo(applyEdit(start, bytes(2)));
    assert.equal(canRedo(back), true);

    const branched = applyEdit(back, bytes(3));
    assert.equal(canRedo(branched), false, 'the undone state is not coming back');
    assert.deepEqual(branched.bytes, bytes(3));
  });

  it('is a no-op when there is nothing to walk back to', () => {
    assert.equal(undo(start), start);
    assert.equal(redo(start), start);
  });

  it('undoes several steps in order', () => {
    let doc = start;
    for (const fill of [2, 3, 4]) doc = applyEdit(doc, bytes(fill));

    doc = undo(doc);
    assert.deepEqual(doc.bytes, bytes(3));
    doc = undo(doc);
    assert.deepEqual(doc.bytes, bytes(2));
    doc = undo(doc);
    assert.deepEqual(doc.bytes, bytes(1));
    assert.equal(canUndo(doc), false);
  });

  it('keeps the document clean-looking again if you undo back to the saved state', () => {
    const edited = applyEdit(start, bytes(2));
    const saved = markSaved(edited, '/docs/a.pdf', edited.bytes);
    assert.equal(isDirty(saved), false);

    const changed = applyEdit(saved, bytes(3));
    assert.equal(isDirty(changed), true);
  });
});

describe('the history budget', () => {
  it('keeps only the most recent steps once the count cap is reached', () => {
    let doc = createDocument(picked('a.pdf', '/docs/a.pdf', 0));
    for (let n = 1; n <= HISTORY_LIMIT + 5; n += 1) doc = applyEdit(doc, bytes(n));

    assert.equal(doc.past.length, HISTORY_LIMIT);
    // The oldest surviving step is not the original document any more.
    assert.notDeepEqual(doc.past[0], bytes(0));
  });

  it('keeps far fewer steps for a large document, so tabs cannot exhaust memory', () => {
    const big = Math.floor(HISTORY_BYTE_BUDGET / 3);
    let doc = createDocument({
      name: 'big.pdf',
      path: '/docs/big.pdf',
      size: big,
      mime: 'application/pdf',
      bytes: new Uint8Array(big),
    });
    for (let n = 1; n <= 6; n += 1) doc = applyEdit(doc, new Uint8Array(big));

    assert.ok(doc.past.length < HISTORY_LIMIT, 'the byte budget binds before the count does');
    const held = doc.past.reduce((total, step) => total + step.length, 0);
    assert.ok(held <= HISTORY_BYTE_BUDGET, `held ${held} bytes, budget is ${HISTORY_BYTE_BUDGET}`);
  });

  it('always keeps at least one step, so a single huge edit stays undoable', () => {
    const huge = HISTORY_BYTE_BUDGET * 2;
    const doc = applyEdit(
      createDocument({
        name: 'huge.pdf',
        path: '/docs/huge.pdf',
        size: huge,
        mime: 'application/pdf',
        bytes: new Uint8Array(huge),
      }),
      new Uint8Array(8),
    );
    assert.equal(canUndo(doc), true);
  });
});

/**
 * Saving happens at a point in the history, not to the document as a whole.
 * A boolean cannot express that: undo and redo move between states the user
 * has already had, and one of those states can be exactly what is on disk.
 * See issue #34.
 */
/**
 * Three different things finish on this path and they are not the same event:
 * saving the document, saving it somewhere else, and exporting a PDF snapshot
 * of it. Only the first two put the open document on disk. Treating an export
 * as a save marks an edited document clean while the disk still holds the old
 * one, and closing the tab then asks nothing. See issue #24.
 */
describe('applyEngineSaved and the three ways a save finishes', () => {
  const hosted = (): DocumentState => ({
    ...createDocument(picked('report.docx', '/docs/report.docx')),
    editor: { sessionId: 's1' } as DocumentState['editor'],
    engineModified: true,
  });

  it('marks the document saved when it was written to its own path', () => {
    const after = applyEngineSaved(hosted(), { path: '/docs/report.docx', name: 'report.docx' });
    assert.equal(after.engineModified, false);
    assert.equal(after.path, '/docs/report.docx');
  });

  it('follows a save-as to the new path', () => {
    const after = applyEngineSaved(hosted(), { path: '/docs/copy.docx', name: 'copy.docx' });
    assert.equal(after.engineModified, false);
    assert.equal(after.path, '/docs/copy.docx');
    assert.equal(after.name, 'copy.docx');
  });

  it('leaves an exported PDF snapshot unsaved, because the document was not written', () => {
    const after = applyEngineSaved(hosted(), {
      path: '/docs/report.docx',
      name: 'report.docx',
      exportedTo: '/docs/report.pdf',
    });

    assert.equal(after.engineModified, true, 'the document still has unsaved changes');
    assert.equal(after.path, '/docs/report.docx', 'the tab stays on the document');
    assert.equal(after.name, 'report.docx');
  });

  it('does not invent unsaved changes when the export came from a clean document', () => {
    const clean = { ...hosted(), engineModified: false };
    const after = applyEngineSaved(clean, {
      path: '/docs/report.docx',
      name: 'report.docx',
      exportedTo: '/docs/report.pdf',
    });

    assert.equal(after.engineModified, false);
  });
});

describe('saved state across undo and redo', () => {
  it('is clean again after undoing an edit made on top of a save', () => {
    const opened = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const editedOnce = applyEdit(opened, bytes(2));
    const saved = markSaved(editedOnce, '/docs/a.pdf', editedOnce.bytes);
    const editedTwice = applyEdit(saved, bytes(3));

    assert.equal(isDirty(editedTwice), true);
    assert.equal(isDirty(undo(editedTwice)), false);
  });

  it('is clean again after undoing past the save and redoing back to it', () => {
    const opened = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const editedOnce2 = applyEdit(opened, bytes(2));
    const saved = markSaved(editedOnce2, '/docs/a.pdf', editedOnce2.bytes);

    const back = undo(saved);
    assert.equal(isDirty(back), true, 'the state before the save is not on disk');
    assert.equal(isDirty(redo(back)), false);
  });

  it('stays dirty on a state that was never written', () => {
    const opened = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const editedOnce2 = applyEdit(opened, bytes(2));
    const saved = markSaved(editedOnce2, '/docs/a.pdf', editedOnce2.bytes);
    const further = applyEdit(applyEdit(saved, bytes(3)), bytes(4));

    assert.equal(isDirty(further), true);
    assert.equal(isDirty(undo(further)), true, 'bytes(3) was never saved');
    assert.equal(isDirty(undo(undo(further))), false, 'back at the saved bytes');
  });

  it('follows the newer save when the document is written twice', () => {
    const opened = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const firstEdit = applyEdit(opened, bytes(2));
    const first = markSaved(firstEdit, '/docs/a.pdf', firstEdit.bytes);
    const secondEdit = applyEdit(first, bytes(3));
    const second = markSaved(secondEdit, '/docs/a.pdf', secondEdit.bytes);

    assert.equal(isDirty(second), false);
    assert.equal(isDirty(undo(second)), true, 'the earlier save is no longer what is on disk');
  });

  it('keeps a document with no file behind it dirty wherever the history sits', () => {
    const untitled = createDocument({ ...picked('new.pdf', ''), path: '' });
    assert.equal(isDirty(untitled), true);
    assert.equal(isDirty(applyEdit(untitled, bytes(2))), true);
  });
});

describe('markSaved', () => {
  it('marks the current bytes as being on disk', () => {
    const editedDoc = applyEdit(createDocument(picked('a.pdf', '/docs/a.pdf')), bytes(2));
    const doc = markSaved(editedDoc, '', editedDoc.bytes);
    assert.equal(isDirty(doc), false);
  });

  it('adopts the new path after a save-as, so ⌘S has somewhere to go', () => {
    const untitled = createDocument(picked('result.pdf', ''));
    const doc = markSaved(untitled, '/docs/result.pdf', untitled.bytes);
    assert.equal(doc.path, '/docs/result.pdf');
  });

  it('leaves the path alone when none is given', () => {
    const fresh = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const doc = markSaved(fresh, '', fresh.bytes);
    assert.equal(doc.path, '/docs/a.pdf');
  });
});

describe('openDocument', () => {
  const a = createDocument(picked('a.pdf', '/docs/a.pdf'));
  const b = createDocument(picked('b.pdf', '/docs/b.pdf'));

  it('adds a document to the end of the list', () => {
    const { documents, activeId } = openDocument([a], b);
    assert.deepEqual(documents.map((d) => d.name), ['a.pdf', 'b.pdf']);
    assert.equal(activeId, b.id);
  });

  it('focuses the existing tab instead of opening the same file twice', () => {
    const again = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const { documents, activeId } = openDocument([a, b], again);
    assert.equal(documents.length, 2, 'no second tab for the same path');
    assert.equal(activeId, a.id, 'the tab already open is the one focused');
  });

  it('does open two tabs for two documents with no path behind them', () => {
    const one = createDocument(picked('result.pdf', ''));
    const two = createDocument(picked('result.pdf', ''));
    const { documents } = openDocument([one], two);
    assert.equal(documents.length, 2, 'in-memory results are not the same document');
  });
});

/**
 * A save writes the bytes it was handed, and finishes later. If the document
 * changed while the write was in flight, recording "what the document is now"
 * as what is on disk marks an edit saved that never reached the file — and the
 * tab then closes without asking, taking the edit with it.
 *
 * What is on disk is what was written. That is the only thing markSaved may
 * record.
 */
describe('markSaved records what was written, not what is current', () => {
  const started = bytes(1);
  const edited = bytes(2);

  it('keeps the document dirty when it changed during the write', () => {
    const opened = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const withStarted = { ...opened, bytes: started };
    const duringWrite = applyEdit(withStarted, edited);

    const saved = markSaved(duringWrite, '', started);

    assert.equal(isDirty(saved), true, 'the edit is not on disk, so it is unsaved');
    assert.equal(saved.savedBytes, started, 'what is on disk is what was written');
  });

  it('marks it clean when nothing changed during the write', () => {
    const opened = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const withStarted = { ...opened, bytes: started };

    assert.equal(isDirty(markSaved(withStarted, '', started)), false);
  });

  /**
   * Undo during the write is the same problem wearing different clothes: the
   * document is back at a version that is not the one on disk.
   */
  it('keeps a document that was undone during the write dirty', () => {
    const opened = createDocument(picked('a.pdf', '/docs/a.pdf'));
    const withStarted = { ...opened, bytes: started };
    const edited2 = applyEdit(withStarted, edited);

    const saved = markSaved(undo(edited2), '', edited);
    assert.equal(isDirty(saved), true);
  });

  it('still takes the new path on save-as', () => {
    const opened = createDocument(picked('a.pdf', ''));
    const saved = markSaved({ ...opened, bytes: started }, '/docs/copy.pdf', started);
    assert.equal(saved.path, '/docs/copy.pdf');
    assert.equal(isDirty(saved), false);
  });
});

describe('partitionOpenPaths', () => {
  const a = createDocument(picked('a.docx', '/docs/a.docx'));
  const b = createDocument(picked('b.xlsx', '/docs/b.xlsx'));

  it('sends a path nothing holds to be opened', () => {
    const { open, fresh } = partitionOpenPaths([a], ['/docs/b.xlsx']);
    assert.deepEqual(open, []);
    assert.deepEqual(fresh, ['/docs/b.xlsx']);
  });

  /**
   * Issue #29: the engine session was created first and the tab deduplicated
   * afterwards, so opening a file that was already open left a session nothing
   * referenced — with the user's document copied into its work directory, and
   * nothing left to close it.
   */
  it('answers with the tab already holding a file rather than opening it again', () => {
    const { open, fresh } = partitionOpenPaths([a, b], ['/docs/a.docx']);
    assert.deepEqual(open.map((doc) => doc.id), [a.id]);
    assert.deepEqual(fresh, [], 'nothing to open, so no session to create');
  });

  it('splits a mixed batch', () => {
    const { open, fresh } = partitionOpenPaths([a], ['/docs/a.docx', '/docs/new.pptx']);
    assert.deepEqual(open.map((doc) => doc.id), [a.id]);
    assert.deepEqual(fresh, ['/docs/new.pptx']);
  });

  it('recognises a path however it is spelled', () => {
    const win = createDocument(picked('r.docx', 'C:/Docs/Report.docx'));
    const { open, fresh } = partitionOpenPaths([win], ['C:\\Docs\\report.DOCX']);
    assert.deepEqual(open.map((doc) => doc.id), [win.id]);
    assert.deepEqual(fresh, []);
  });

  it('opens one session when the same file is named twice in one batch', () => {
    const { fresh } = partitionOpenPaths([], ['/docs/new.pptx', '/docs/new.pptx']);
    assert.deepEqual(fresh, ['/docs/new.pptx'], 'two sessions for one tab is the leak again');
  });

  it('ignores tabs with no file behind them', () => {
    const result = createDocument(picked('result.pdf', ''));
    const { open, fresh } = partitionOpenPaths([result], ['/docs/new.pptx']);
    assert.deepEqual(open, []);
    assert.deepEqual(fresh, ['/docs/new.pptx']);
  });
});

describe('normalizeDocumentPath', () => {
  it('makes the separators and the case agree where the filesystem does', () => {
    setPathCaseSensitivity('darwin');
    assert.equal(normalizeDocumentPath('C:\\Docs\\Report.docx'), 'c:/docs/report.docx');
    assert.equal(normalizeDocumentPath('/docs/Report.docx'), '/docs/report.docx');
    setPathCaseSensitivity('win32');
    assert.equal(normalizeDocumentPath('C:\\Docs\\Report.docx'), 'c:/docs/report.docx');
  });

  /**
   * Linux does distinguish them, and this app ships an AppImage and a .deb.
   * Folding the case there made two different documents share one tab —
   * opening the second silently focused the first.
   */
  it('keeps two files apart on a filesystem that keeps them apart', () => {
    setPathCaseSensitivity('linux');
    assert.notEqual(normalizeDocumentPath('/docs/A.docx'), normalizeDocumentPath('/docs/a.docx'));
    assert.equal(normalizeDocumentPath('/docs/Report.docx'), '/docs/Report.docx');
  });

  /**
   * A backslash is a legal character in a Linux filename, so rewriting it as a
   * separator would merge `/docs/a\b.pdf` with `/docs/a/b.pdf`.
   */
  it('leaves a backslash alone where it is part of the name', () => {
    setPathCaseSensitivity('linux');
    assert.equal(normalizeDocumentPath('/docs/a\\b.pdf'), '/docs/a\\b.pdf');
    setPathCaseSensitivity('win32');
    assert.equal(normalizeDocumentPath('/docs/a\\b.pdf'), '/docs/a/b.pdf');
  });

  it('folds case by default, which is what Windows and macOS do', () => {
    setPathCaseSensitivity('darwin');
    assert.equal(normalizeDocumentPath('/Docs/A.PDF'), '/docs/a.pdf');
  });
});

describe('replaceDocument', () => {
  const a = createDocument(picked('a.pdf', '/docs/a.pdf'));
  const b = createDocument(picked('b.pdf', '/docs/b.pdf'));
  const c = createDocument(picked('c.pdf', '/docs/c.pdf'));

  it('takes the old tab position rather than moving to the end', () => {
    const rewritten = createDocument(picked('b.pdf', '/docs/b.pdf', 9));
    const documents = replaceDocument([a, b, c], b.id, rewritten);
    assert.deepEqual(documents.map((d) => d.id), [a.id, rewritten.id, c.id]);
  });

  it('drops another tab left on the same file, so the swap cannot duplicate it', () => {
    const stale = createDocument(picked('b.pdf', '/docs/b.pdf', 2));
    const rewritten = createDocument(picked('b.pdf', '/docs/b.pdf', 9));
    const documents = replaceDocument([a, b, stale], b.id, rewritten);
    assert.deepEqual(documents.map((d) => d.id), [a.id, rewritten.id]);
  });

  it('appends when the tab it should replace is already gone', () => {
    const rewritten = createDocument(picked('d.pdf', '/docs/d.pdf'));
    const documents = replaceDocument([a], 'missing-id', rewritten);
    assert.deepEqual(documents.map((d) => d.id), [a.id, rewritten.id]);
  });
});

describe('documents rendered from an Office file', () => {
  const preview = (): PickedFile => ({
    ...picked('报告.pdf', ''),
    origin: { path: '/docs/报告.docx', kind: 'word' },
  });

  it('remembers the Office file it was rendered from', () => {
    const doc = createDocument(preview());
    assert.deepEqual(doc.origin, { path: '/docs/报告.docx', kind: 'word' });
  });

  it('is an ordinary document when it came from a real PDF', () => {
    const doc = createDocument(picked('a.pdf', '/docs/a.pdf'));
    assert.equal(doc.origin, null);
  });

  /**
   * The bytes in this tab are a PDF rendering, and the path it came from is a
   * .docx. Writing one over the other destroys the user's document, so a
   * rendered document has no path to save over — Save As is the only route.
   */
  it('never carries a path that Save would overwrite', () => {
    const doc = createDocument(preview());
    assert.equal(doc.path, '');
  });

  /** Saving elsewhere produces a normal PDF, no longer tied to the source. */
  it('stops being a rendering once it is saved somewhere of its own', () => {
    const rendering = createDocument(preview());
    const saved = markSaved(rendering, '/docs/报告.pdf', rendering.bytes);
    assert.equal(saved.path, '/docs/报告.pdf');
    assert.equal(saved.origin, null);
  });

  /**
   * Two renderings of the same source are the same tab. Without this they
   * would stack up, because a rendering has no path to match on.
   */
  it('focuses the existing tab when the same Office file is opened again', () => {
    const first = openDocument([], createDocument(preview()));
    const second = openDocument(first.documents, createDocument(preview()));
    assert.equal(second.documents.length, 1);
    assert.equal(second.activeId, first.documents[0]?.id);
  });
});

describe('documents held by the editor engine', () => {
  const hosted = (overrides: Partial<PickedFile> = {}): PickedFile => ({
    ...picked('报告.docx', '/docs/报告.docx', 0),
    bytes: new Uint8Array(0),
    editor: { sessionId: 'sess1', url: 'http://127.0.0.1:5000/editor/sess1', editorType: 'word' },
    ...overrides,
  });

  it('remembers the session the engine is holding it in', () => {
    const doc = createDocument(hosted());
    assert.deepEqual(doc.editor, {
      sessionId: 'sess1',
      url: 'http://127.0.0.1:5000/editor/sess1',
      editorType: 'word',
    });
  });

  it('is an ordinary document when no engine is involved', () => {
    assert.equal(createDocument(picked('a.pdf', '/docs/a.pdf')).editor, null);
  });

  /**
   * The bytes live in the engine, not here, so this tab's history is the
   * engine's too. Reporting anything else would offer an Undo that silently
   * did nothing.
   */
  it('has no history of its own', () => {
    const doc = createDocument(hosted());
    assert.equal(canUndo(doc), false);
    assert.equal(canRedo(doc), false);
    assert.equal(doc.bytes.length, 0);
  });

  /** Editing happens in the engine, which tells us when it has begun. */
  it('takes its dirty state from the engine', () => {
    const doc = createDocument(hosted());
    assert.equal(isDirty(doc), false);
    assert.equal(isDirty(setEngineModified(doc, true)), true);
    assert.equal(isDirty(setEngineModified(doc, false)), false);
  });

  /** It has a real file behind it, so ⌘S means "write it back", not Save As. */
  it('keeps the path of the file it was opened from', () => {
    assert.equal(createDocument(hosted()).path, '/docs/报告.docx');
  });

  it('is the same tab when the same file is opened again', () => {
    const first = openDocument([], createDocument(hosted()));
    const second = openDocument(first.documents, createDocument(hosted()));
    assert.equal(second.documents.length, 1);
  });

  /**
   * "New" in the engine's file menu must create the same kind of document as
   * the one in front. Without the editor type on the tab, every new document
   * would be Word — even when the open one is a sheet or a deck.
   */
  it('carries the engine type so New can match the open document', () => {
    const sheet = createDocument(
      hosted({
        name: '表.xlsx',
        path: '/docs/表.xlsx',
        editor: { sessionId: 's2', url: 'http://127.0.0.1:9/e/s2', editorType: 'cell' },
      }),
    );
    assert.equal(officeCreateKind(sheet), 'sheet');
    assert.equal(
      officeCreateKind(
        createDocument(
          hosted({
            name: 'deck.pptx',
            path: '/docs/deck.pptx',
            editor: { sessionId: 's3', url: 'http://127.0.0.1:9/e/s3', editorType: 'slide' },
          }),
        ),
      ),
      'slide',
    );
    assert.equal(officeCreateKind(createDocument(hosted())), 'word');
  });

  /** Falls back to the file name when an older session lacks editorType. */
  it('infers the create kind from the file name when the type is missing', () => {
    const doc = createDocument(
      hosted({
        name: 'budget.xlsx',
        path: '/docs/budget.xlsx',
        editor: { sessionId: 's4', url: 'http://127.0.0.1:9/e/s4' },
      }),
    );
    assert.equal(officeCreateKind(doc), 'sheet');
  });

  /**
   * Save As rewrites the session's path in the main process. The tab has to
   * follow, or the next ⌘S and the tab title still point at the original.
   */
  it('adopts the path and name the engine saved under', () => {
    const dirty = setEngineModified(createDocument(hosted()), true);
    const saved = applyEngineSaved(dirty, { path: '/docs/copy.docx', name: 'copy.docx' });
    assert.equal(saved.path, '/docs/copy.docx');
    assert.equal(saved.name, 'copy.docx');
    assert.equal(isDirty(saved), false);
  });

  it('clears dirty even when the path did not change', () => {
    const dirty = setEngineModified(createDocument(hosted()), true);
    assert.equal(isDirty(applyEngineSaved(dirty, {})), false);
  });
});

describe('where ⌘S sends a document', () => {
  const hosted = (): PickedFile => ({
    ...picked('报告.docx', '/docs/报告.docx', 0),
    bytes: new Uint8Array(0),
    editor: { sessionId: 'sess1', url: 'http://127.0.0.1:5000/editor/sess1', editorType: 'word' },
  });

  /**
   * The bytes of a hosted document are in the engine; the shell holds an empty
   * array. Writing that over the path would truncate the user's document to
   * nothing, so this decision is a function rather than a condition buried in
   * the store where nothing checks it.
   */
  it('sends a hosted document to the engine, never to a direct write', () => {
    assert.equal(saveTarget(createDocument(hosted())), 'engine');
  });

  it('writes an ordinary document straight to its path', () => {
    assert.equal(saveTarget(createDocument(picked('a.pdf', '/docs/a.pdf'))), 'path');
  });

  it('asks where to put a document that has no path yet', () => {
    assert.equal(saveTarget(createDocument(picked('result.pdf', ''))), 'prompt');
  });

  /** A rendering has no path by construction; it must never be written back. */
  it('asks where to put a rendering', () => {
    const rendering = createDocument({
      ...picked('报告.pdf', ''),
      origin: { path: '/docs/报告.docx', kind: 'word' },
    });
    assert.equal(saveTarget(rendering), 'prompt');
  });
});

describe('the name Save As proposes', () => {
  /**
   * A rendering's bytes are a PDF while its name still ends in .docx, because
   * the tab shows the document the user opened. Proposing that name would save
   * a PDF as a Word file — openable by nothing.
   */
  it('proposes a PDF name for a rendering', () => {
    const doc = createDocument({
      ...picked('报告.docx', ''),
      origin: { path: '/docs/报告.docx', kind: 'word' },
    });
    assert.equal(saveAsName(doc), '报告.pdf');
  });

  it('leaves an ordinary document name alone', () => {
    assert.equal(saveAsName(createDocument(picked('a.pdf', '/docs/a.pdf'))), 'a.pdf');
  });

  it('copes with a name that has no extension', () => {
    const doc = createDocument({
      ...picked('报告', ''),
      origin: { path: '/docs/报告', kind: 'word' },
    });
    assert.equal(saveAsName(doc), '报告.pdf');
  });
});

describe('closeDocument / nextActiveId', () => {
  const a = createDocument(picked('a.pdf', '/docs/a.pdf'));
  const b = createDocument(picked('b.pdf', '/docs/b.pdf'));
  const c = createDocument(picked('c.pdf', '/docs/c.pdf'));

  it('removes only the document asked for', () => {
    assert.deepEqual(
      closeDocument([a, b, c], b.id).map((d) => d.name),
      ['a.pdf', 'c.pdf'],
    );
  });

  it('moves to the tab on the right when the active one closes', () => {
    assert.equal(nextActiveId([a, b, c], b.id, b.id), c.id);
  });

  it('falls back to the left when the last tab closes', () => {
    assert.equal(nextActiveId([a, b, c], c.id, c.id), b.id);
  });

  it('leaves the active tab alone when a different one closes', () => {
    assert.equal(nextActiveId([a, b, c], c.id, a.id), a.id);
  });

  it('reports no active document once the last tab is gone', () => {
    assert.equal(nextActiveId([a], a.id, a.id), null);
  });
});
