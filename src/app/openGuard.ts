import { normalizeDocumentPath } from './documents.ts';

/**
 * Which files are being opened right now.
 *
 * `partitionOpenPaths` answers "is this file already a tab", which is the right
 * question once opening has finished and the wrong one while it is still in
 * flight. Two requests for the same document that overlap — a drop arriving as
 * `open-file` fires, the same file named twice by different routes — both see
 * no tab and both ask the engine for a session. One tab appears; the other
 * session is left with nothing referencing it and nothing able to close it,
 * still holding a copy of the user's document in a temp directory.
 *
 * That is the leak issue #29 closed for every path except the overlapping one,
 * because a tab is created too late to deduplicate against.
 */
export interface OpenGuard {
  /** The paths the caller may open, marked as being opened. */
  claim(paths: readonly string[]): string[];
  /** Gives them back, whether the open succeeded or failed. */
  release(paths: readonly string[]): void;
  /** What is still in flight, normalized. For tests. */
  pending(): string[];
}

export function createOpenGuard(): OpenGuard {
  const opening = new Set<string>();

  return {
    claim(paths) {
      const claimed: string[] = [];
      for (const candidate of paths) {
        if (!candidate) continue;
        const key = normalizeDocumentPath(candidate);
        if (opening.has(key)) continue;
        opening.add(key);
        claimed.push(candidate);
      }
      return claimed;
    },

    release(paths) {
      for (const candidate of paths) {
        if (!candidate) continue;
        opening.delete(normalizeDocumentPath(candidate));
      }
    },

    pending: () => [...opening],
  };
}
