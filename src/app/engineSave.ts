/**
 * The lifetime of one "write this document" request to the editor engine.
 *
 * Saving a hosted document is not something the shell does; it is something it
 * asks for. The frame passes the request to the engine, the engine posts the
 * document to the main process, and only then does it reach the disk. So the
 * request has a beginning here and an end somewhere else, and everything that
 * waits on a save — closing a tab, quitting — needs a promise that settles at
 * the *end*, not at the asking.
 *
 * The clock is injected so the timeout can be tested without waiting for it.
 */

export interface Clock {
  setTimeout(run: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface EngineSaveTracker {
  /** Starts a request. The promise settles when the engine answers. */
  begin(id: string, timeoutMs: number): Promise<void>;
  /** The engine wrote the document. */
  saved(): void;
  /** The engine could not write it. */
  failed(message: string): void;
  /** Whether a request is outstanding. */
  pending(): boolean;
  /** The document a request is outstanding for, or null. */
  waitingFor(): string | null;
}

interface Outstanding {
  id: string;
  resolve: () => void;
  reject: (cause: Error) => void;
  timer: number;
}

const defaultClock: Clock = {
  setTimeout: (run, ms) => setTimeout(run, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createEngineSaveTracker(clock: Clock = defaultClock): EngineSaveTracker {
  let outstanding: Outstanding | null = null;

  /** Takes the outstanding request, cancelling its timeout. */
  function take(): Outstanding | null {
    if (!outstanding) return null;
    const held = outstanding;
    outstanding = null;
    clock.clearTimeout(held.timer);
    return held;
  }

  return {
    begin(id, timeoutMs) {
      // A second request while one is in flight: the first will never be
      // answered now, and leaving it pending would hang whatever waits on it.
      take()?.reject(new Error('The save was superseded by a later one'));

      return new Promise<void>((resolve, reject) => {
        const timer = clock.setTimeout(() => {
          outstanding = null;
          reject(new Error('The editor did not answer the save in time'));
        }, timeoutMs);
        outstanding = { id, resolve, reject, timer };
      });
    },

    saved() {
      take()?.resolve();
    },

    failed(message) {
      take()?.reject(new Error(message));
    },

    pending() {
      return outstanding !== null;
    },

    waitingFor() {
      return outstanding?.id ?? null;
    },
  };
}
