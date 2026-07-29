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
