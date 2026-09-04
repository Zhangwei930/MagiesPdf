import { normalizeDocumentPath } from './documents.ts';

/**
 * When to reopen a document the AI has rewritten on disk.
 *
 * One AI request usually writes the same file several times over, and each
 * reopen is a full engine boot — so a write does not reload immediately, it
 * waits for the writes to that file to stop.
 *
 * The waiting used to be done by a single timer. That is correct for one file
 * and wrong for two: writing B cancelled the reload A was waiting for, and A's
 * tab was left holding a session that had already been closed, with no way back
 * (issue #30). So the wait is per file, keyed by the path the way the
 * filesystem would compare it.
 *
 * Pure apart from the timers, which are injected, so the coalescing is tested
 * without waiting a real second.
 */

export interface ReloadTimers {
  setTimeout(run: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

const REAL_TIMERS: ReloadTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface ReloadQueueOptions {
  /** How long the writes to one file must stop before it is reopened. */
  settleMs: number;
  reload: (absolutePath: string) => void;
  timers?: ReloadTimers;
}

export interface ReloadQueue {
  /** Notes a write, restarting only that file's wait. */
  schedule(absolutePath: string): void;
  /** Forgets one file — its session was just closed for another write. */
  cancel(absolutePath: string): void;
  /** Drops every pending reload — the subscription is going away. */
  cancelAll(): void;
  /** Which files are still waiting, normalized. For tests. */
  waiting(): string[];
}

export function createReloadQueue(options: ReloadQueueOptions): ReloadQueue {
  const timers = options.timers ?? REAL_TIMERS;
  const pending = new Map<string, number>();

  return {
    schedule(absolutePath) {
      if (!absolutePath) return;
      const key = normalizeDocumentPath(absolutePath);
      const running = pending.get(key);
      if (running !== undefined) timers.clearTimeout(running);
      pending.set(
        key,
        timers.setTimeout(() => {
          pending.delete(key);
          options.reload(absolutePath);
        }, options.settleMs),
      );
    },

    cancel(absolutePath) {
      if (!absolutePath) return;
      const key = normalizeDocumentPath(absolutePath);
      const running = pending.get(key);
      if (running === undefined) return;
      timers.clearTimeout(running);
      pending.delete(key);
    },

    cancelAll() {
      for (const handle of pending.values()) timers.clearTimeout(handle);
      pending.clear();
    },

    waiting: () => [...pending.keys()],
  };
}
