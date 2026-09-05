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

/**
 * The Office file a document was rendered from.
 *
 * A Word, Sheet or Slide file opens as a tab by being rendered to PDF, so what
 * the tab holds is a *view* of a file it cannot write back. Recording where the
 * view came from is what keeps the tab honest: it can say which document it is
 * showing, and it can refuse to save over it.
 */
/**
 * Whether this machine's filesystem treats two spellings as one file.
 *
 * Windows and macOS do; Linux does not, and this app ships an AppImage and a
 * .deb. Folding the case everywhere made `/docs/A.docx` and `/docs/a.docx`
 * share a tab there — opening the second silently focused the first, which
 * looks like the document failing to open.
 *
 * Set once from `bridge().platform`. It defaults to folding, because that is
 * what the two platforms most people run do, and because a missed fold merely
 * opens a second tab while a wrong one hides a document.
 */
let pathsFoldCase = true;

export function setPathCaseSensitivity(platform: string): void {
  pathsFoldCase = platform !== 'linux';
}

/**
 * How two paths are compared when asking whether a file is already open.
 *
 * Windows accepts either separator and does not distinguish case, so the same
 * document reaches us spelled several ways — from argv, from a drop, from the
 * AI's own idea of where it wrote. Comparing the strings as they arrive opens a
 * second tab on a file that is already open, and a second engine session with
 * it. Not a real-path resolution: this is pure, and the answer is only ever
 * used to reuse a tab.
 *
 * Where case matters, so does the separator: a backslash is a legal character
 * in a Linux filename, and rewriting it would merge `/docs/a\b.pdf` with
 * `/docs/a/b.pdf`.
 */
export function normalizeDocumentPath(candidate: string): string {
  if (!pathsFoldCase) return candidate;
  return candidate.replace(/\\/g, '/').toLowerCase();
}

export interface DocumentOrigin {
  path: string;
  kind: 'word' | 'sheet' | 'slide';
}

/**
 * A document the editor engine is holding open.
 *
 * Its bytes are not here — they live in the engine, behind a session. So is its
 * history, and so is the decision that it has unsaved changes. This tab is a
 * window onto that session rather than a copy of the file.
 */
export interface EditorSession {
  sessionId: string;
  url: string;
  /**
   * What the engine is editing: `word`, `cell`, or `slide`. Used by the shell
   * when the file menu asks for a new document of the same kind.
   */
  editorType?: string;
}

import type { TextHighlight } from './pdf/highlights.ts';
import type { InkAnnotation } from './pdf/inkAnnotation.ts';

export interface DocumentState {
  id: string;
  name: string;
  /**
   * Where ⌘S writes. `''` for a document with no file behind it yet — which
   * includes every rendering, because its bytes are a PDF and its source is
   * not, and writing one over the other would destroy the user's document.
   */
  path: string;
  bytes: Uint8Array;
  /** Previous states, oldest first. */
  past: Uint8Array[];
  /** Undone states, nearest first. */
  future: Uint8Array[];
  /** Accepted password for an encrypted document, replayed into every edit. */
  password: string;
  /**
   * The exact bytes last written to `path`, or null when nothing has been.
   *
   * Identity, not a flag: undo and redo move between states the user already
   * had, and one of them can be the one on disk. `past` and `future` carry the
   * same array references this points at, so `bytes === savedBytes` answers
   * "is this what is on disk" in constant time, without hashing a scan.
   */
  savedBytes: Uint8Array | null;
  /** Set only while this document is a rendering of an Office file. */
  origin: DocumentOrigin | null;
  /** Set only while the editor engine is holding this document open. */
  editor: EditorSession | null;
  /** What the engine last said about unsaved changes. Meaningless without one. */
  engineModified: boolean;
  /** Highlights added to the document via the viewer */
  highlights?: Record<number, TextHighlight[]>;
  /** Ink annotations added to the document via the viewer */
  inkAnnotations?: Record<number, InkAnnotation[]>;
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
  const origin = file.origin ?? null;
  // A rendering never adopts a path: `file.path` would be the .docx, and
  // these bytes are a PDF.
  const path = origin ? '' : file.path;
  return {
    id: crypto.randomUUID(),
    name: file.name,
    path,
    bytes: file.bytes,
    past: [],
    future: [],
    password: '',
    // Opened from a file, these bytes are exactly what is on disk.
    savedBytes: path === '' ? null : file.bytes,
    origin,
    editor: file.editor ?? null,
    engineModified: false,
    highlights: {},
    inkAnnotations: {},
  };
}

/**
 * Records what the engine says about unsaved changes.
 *
 * A hosted document's edits happen inside the engine, so this is the only way
 * the shell can know the tab is dirty.
 */
export function setEngineModified(doc: DocumentState, modified: boolean): DocumentState {
  return { ...doc, engineModified: modified };
}

/**
 * What "New" should create when the open document is held by the engine.
 *
 * The engine's own type is authoritative (`cell` is a sheet). Falling back to
 * the file name covers older sessions that never carried a type, so a missing
 * field never silently turns every new document into Word.
 */
export function officeCreateKind(doc: DocumentState): DocumentOrigin['kind'] {
  const type = doc.editor?.editorType;
  if (type === 'cell') return 'sheet';
  if (type === 'slide') return 'slide';
  if (type === 'word') return 'word';

  const name = (doc.path || doc.name).toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.ods')) return 'sheet';
  if (name.endsWith('.pptx') || name.endsWith('.ppt') || name.endsWith('.odp')) return 'slide';
  return 'word';
}

/**
 * Applies what the main process reports after a successful engine save.
 *
 * Save As rewrites the session's path there; the tab has to follow, or the
 * title and the next ⌘S still point at the original file.
 */
export function applyEngineSaved(
  doc: DocumentState,
  saved: { path?: string; name?: string; exportedTo?: string },
): DocumentState {
  // An exported PDF is a snapshot beside the document, not the document. The
  // engine still holds unsaved changes and the tab still edits the original —
  // clearing the flag here would mark it clean over bytes never written.
  if (saved.exportedTo) return doc;

  return {
    ...doc,
    engineModified: false,
    path: typeof saved.path === 'string' && saved.path !== '' ? saved.path : doc.path,
    name: typeof saved.name === 'string' && saved.name !== '' ? saved.name : doc.name,
  };
}

export function canUndo(doc: DocumentState): boolean {
  return doc.past.length > 0;
}

export function canRedo(doc: DocumentState): boolean {
  return doc.future.length > 0;
}

/**
 * Whether there are changes that are not on disk.
 *
 * A hosted document is edited inside the engine, which is the only thing that
 * knows — the shell holds none of its bytes to compare.
 */
export function isDirty(doc: DocumentState): boolean {
  if (doc.editor) return doc.engineModified;
  return doc.path === '' || doc.bytes !== doc.savedBytes;
}

/** Whether two buffers hold the same bytes. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

/**
 * A run that hands back the bytes it was given did not edit anything, and
 * recording it as an edit is a lie the user has to act on: an undo step that
 * undoes nothing, and a tab marked unsaved with nothing to save. `edit.fill-form`
 * in "list fields only" mode does exactly that — it reads, and returns the
 * document it read.
 */
export function applyEdit(doc: DocumentState, bytes: Uint8Array): DocumentState {
  if (bytesEqual(doc.bytes, bytes)) return doc;
  return {
    ...doc,
    bytes,
    past: trimHistory([...doc.past, doc.bytes]),
    // A new edit is a new branch; whatever was undone is not coming back.
    future: [],
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
  };
}

/**
 * Records that the current bytes reached disk, adopting the path if given.
 *
 * Saving a rendering writes a PDF the user chose the location of, so from then
 * on it is that PDF and not a view of the Office file it started as.
 */
/**
 * Records what reached the disk.
 *
 * `written` is the array the save was handed, not the document's current
 * bytes: a write finishes later, and an edit made while it was in flight is
 * not on disk. Recording "whatever the document is now" marked that edit saved
 * — the tab showed no changes, closing it asked nothing, and the edit was
 * gone. The parameter is required so the distinction cannot be lost again by
 * someone reading the shorter call as equivalent.
 */
export function markSaved(
  doc: DocumentState,
  path: string,
  written: Uint8Array,
): DocumentState {
  return {
    ...doc,
    path: path === '' ? doc.path : path,
    savedBytes: written,
    origin: path === '' ? doc.origin : null,
  };
}

/**
 * Where ⌘S should send a document.
 *
 * A hosted document keeps the path of the file it came from, but its bytes are
 * in the engine and `bytes` here is empty. Writing that to the path would
 * truncate the user's document to nothing, so the choice is made here — as a
 * value that can be tested — rather than as a condition inside the store.
 */
export function saveTarget(doc: DocumentState): 'engine' | 'path' | 'prompt' {
  if (doc.editor) return 'engine';
  return doc.path === '' ? 'prompt' : 'path';
}

/**
 * The filename Save As should propose.
 *
 * A rendering is named after the document it shows — `报告.docx` — while its
 * bytes are the PDF that was rendered from it. Offering that name would write a
 * PDF into a file called `.docx`, which nothing can open. What is being saved
 * is the rendering, so what is proposed is a `.pdf`.
 */
export function saveAsName(doc: DocumentState): string {
  if (!doc.origin) return doc.name;
  const dot = doc.name.lastIndexOf('.');
  return `${dot > 0 ? doc.name.slice(0, dot) : doc.name}.pdf`;
}

export function setPassword(doc: DocumentState, password: string): DocumentState {
  return { ...doc, password };
}

/**
 * Adds a document, or focuses the tab that already holds that file.
 *
 * Documents with no path are results held in memory, so two of them are two
 * different documents even when they share a name. A rendering is the
 * exception: it has no path but it does name a source file, and opening the
 * same Office file twice should land on the tab already showing it.
 */
export function openDocument(
  documents: readonly DocumentState[],
  incoming: DocumentState,
): { documents: DocumentState[]; activeId: string } {
  const existing = incoming.origin
    ? documents.find((document) => document.origin?.path === incoming.origin?.path)
    : incoming.path === ''
      ? undefined
      : documents.find((document) => document.path === incoming.path);

  if (existing) return { documents: [...documents], activeId: existing.id };
  return { documents: [...documents, incoming], activeId: incoming.id };
}

/**
 * Splits paths into the tabs that already hold them and the ones left to open.
 *
 * `openDocument` deduplicates too, but it does it too late for an Office file:
 * by the time the tab is being added, the engine has already converted the
 * document into a work directory and published a session for it. Focusing the
 * old tab then drops the new session on the floor, still holding a copy of the
 * user's document (issue #29). Asking this first means the session is never
 * created.
 */
export function partitionOpenPaths(
  documents: readonly DocumentState[],
  paths: readonly string[],
): { open: DocumentState[]; fresh: string[] } {
  const byPath = new Map<string, DocumentState>();
  for (const document of documents) {
    if (document.path !== '') byPath.set(normalizeDocumentPath(document.path), document);
  }

  const open: DocumentState[] = [];
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    const key = normalizeDocumentPath(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const held = byPath.get(key);
    if (held) open.push(held);
    else fresh.push(candidate);
  }
  return { open, fresh };
}

/**
 * Swaps one document for another, keeping its place in the tab strip.
 *
 * An AI write rewrites a file the engine already holds, so the old session dies
 * and a fresh one takes over the same path. Closing the tab and opening it again
 * empties the list for a moment — the shell falls back to the welcome screen and
 * the whole window appears to restart. Replacing in place never does that.
 *
 * Any other tab left on the same file goes with it: the document was reopened,
 * not duplicated.
 */
export function replaceDocument(
  documents: readonly DocumentState[],
  id: string,
  incoming: DocumentState,
): DocumentState[] {
  const index = documents.findIndex((document) => document.id === id);
  if (index < 0) return [...documents, incoming];
  return documents.flatMap((document, at) => {
    if (at === index) return [incoming];
    if (incoming.path !== '' && document.path === incoming.path) return [];
    return [document];
  });
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
