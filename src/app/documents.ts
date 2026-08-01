import type { PickedFile } from './bridge.ts';

/**
 * The open-document model: what a tab is, and what undo means.
 *
 * Editing used to live inside the Viewer component, which meant only the Viewer
 * could edit and only one document could be open. Holding it here instead lets
 * a tool run against the document the user is looking at and have the result
 * land in the same undo history as a rotate.
 *
 * Every function is pure and returns a new document, so the store's job is only
 * to say which document an action applies to.
 */

export interface DocumentState {
  id: string;
  name: string;
  /** Where ⌘S writes. `''` for a document with no file behind it yet. */
  path: string;
  bytes: Uint8Array;
  /** Previous states, oldest first. */
  past: Uint8Array[];
  /** Undone states, nearest first. */
  future: Uint8Array[];
  /** Accepted password for an encrypted document, replayed into every edit. */
  password: string;
  /** True while `bytes` is what is on disk at `path`. */
  saved: boolean;
}

/** Undo steps kept, at most. Each one is a whole copy of the document. */
export const HISTORY_LIMIT = 10;

/**
 * How many bytes of history one document may hold. Ten copies of a 200 MB scan
 * across a few tabs would exhaust memory, so on large documents this binds long
 * before the step count does — fewer undo steps beats being killed.
 */
export const HISTORY_BYTE_BUDGET = 192 * 1024 * 1024;

/**
 * Trims history to both caps, keeping the newest. At least one step always
 * survives: a document too big for the budget would otherwise not be undoable
 * at all, which is worse than holding one copy of it.
 */
function trimHistory(past: Uint8Array[]): Uint8Array[] {
  const capped = past.slice(-HISTORY_LIMIT);

  let held = 0;
  const kept: Uint8Array[] = [];
  for (let index = capped.length - 1; index >= 0; index -= 1) {
    const step = capped[index];
    if (!step) continue;
    held += step.length;
    if (held > HISTORY_BYTE_BUDGET && kept.length > 0) break;
    kept.unshift(step);
  }
  return kept;
}

export function createDocument(file: PickedFile): DocumentState {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    path: file.path,
    bytes: file.bytes,
    past: [],
    future: [],
    password: '',
    saved: false,
  };
}

export function canUndo(doc: DocumentState): boolean {
  return doc.past.length > 0;
}

export function canRedo(doc: DocumentState): boolean {
  return doc.future.length > 0;
}

/** Whether there are changes that are not on disk. */
export function isDirty(doc: DocumentState): boolean {
  return doc.path === '' || (doc.past.length > 0 && !doc.saved);
}

export function applyEdit(doc: DocumentState, bytes: Uint8Array): DocumentState {
  return {
    ...doc,
    bytes,
    past: trimHistory([...doc.past, doc.bytes]),
    // A new edit is a new branch; whatever was undone is not coming back.
    future: [],
    saved: false,
  };
}

export function undo(doc: DocumentState): DocumentState {
  const previous = doc.past[doc.past.length - 1];
  if (!previous) return doc;
  return {
    ...doc,
    bytes: previous,
    past: doc.past.slice(0, -1),
    future: [doc.bytes, ...doc.future].slice(0, HISTORY_LIMIT),
    saved: false,
  };
}

export function redo(doc: DocumentState): DocumentState {
  const next = doc.future[0];
  if (!next) return doc;
  return {
    ...doc,
    bytes: next,
    past: trimHistory([...doc.past, doc.bytes]),
    future: doc.future.slice(1),
    saved: false,
  };
}

/** Records that the current bytes reached disk, adopting the path if given. */
export function markSaved(doc: DocumentState, path: string): DocumentState {
  return { ...doc, path: path === '' ? doc.path : path, saved: true };
}

export function setPassword(doc: DocumentState, password: string): DocumentState {
  return { ...doc, password };
}

/**
 * Adds a document, or focuses the tab that already holds that file.
 *
 * Documents with no path are results held in memory, so two of them are two
 * different documents even when they share a name.
 */
export function openDocument(
  documents: readonly DocumentState[],
  incoming: DocumentState,
): { documents: DocumentState[]; activeId: string } {
  const existing =
    incoming.path === ''
      ? undefined
      : documents.find((document) => document.path === incoming.path);

  if (existing) return { documents: [...documents], activeId: existing.id };
  return { documents: [...documents, incoming], activeId: incoming.id };
}

export function closeDocument(
  documents: readonly DocumentState[],
  id: string,
): DocumentState[] {
  return documents.filter((document) => document.id !== id);
}

/**
 * Which tab to show after `closingId` goes away. Closing the tab you are on
 * moves right, or left when there is nothing to the right — the same as a
 * browser, and the only behaviour that never feels like it jumped.
 */
export function nextActiveId(
  documents: readonly DocumentState[],
  closingId: string,
  activeId: string | null,
): string | null {
  if (activeId !== closingId) return activeId;

  const index = documents.findIndex((document) => document.id === closingId);
  if (index < 0) return activeId;

  const remaining = documents.filter((document) => document.id !== closingId);
  if (remaining.length === 0) return null;
  return (remaining[index] ?? remaining[remaining.length - 1])?.id ?? null;
}
