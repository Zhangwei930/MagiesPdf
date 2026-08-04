import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HISTORY_BYTE_BUDGET,
  HISTORY_LIMIT,
  applyEdit,
  canRedo,
  canUndo,
  closeDocument,
  createDocument,
  isDirty,
  markSaved,
  nextActiveId,
  openDocument,
  redo,
  saveAsName,
  setEngineModified,
  undo,
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
    const saved = markSaved(applyEdit(start, bytes(2)), '/docs/a.pdf');
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

describe('markSaved', () => {
  it('marks the current bytes as being on disk', () => {
    const doc = markSaved(applyEdit(createDocument(picked('a.pdf', '/docs/a.pdf')), bytes(2)), '');
    assert.equal(isDirty(doc), false);
  });

  it('adopts the new path after a save-as, so ⌘S has somewhere to go', () => {
    const untitled = createDocument(picked('result.pdf', ''));
    const doc = markSaved(untitled, '/docs/result.pdf');
    assert.equal(doc.path, '/docs/result.pdf');
  });

  it('leaves the path alone when none is given', () => {
    const doc = markSaved(createDocument(picked('a.pdf', '/docs/a.pdf')), '');
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
    const saved = markSaved(createDocument(preview()), '/docs/报告.pdf');
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
  const hosted = (): PickedFile => ({
    ...picked('报告.docx', '/docs/报告.docx', 0),
    bytes: new Uint8Array(0),
    editor: { sessionId: 'sess1', url: 'http://127.0.0.1:5000/editor/sess1' },
  });

  it('remembers the session the engine is holding it in', () => {
    const doc = createDocument(hosted());
    assert.deepEqual(doc.editor, {
      sessionId: 'sess1',
      url: 'http://127.0.0.1:5000/editor/sess1',
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
