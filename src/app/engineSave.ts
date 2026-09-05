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
 * Requests are kept per document. One outstanding request for the whole app
 * meant two documents saving at once — which is what "save all" on quit is —
 * superseded each other, and whichever answer arrived first settled whoever
 * happened to be waiting: save A, save B, and A's late answer resolved B, so
 * B's tab closed believing it had reached the disk.
 *
 * Two saves of *the same* document are the case a document id cannot tell
 * apart, so they are not allowed to coexist: the second joins the first.
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
  /** The engine wrote that document. */
  saved(id: string): void;
  /** The engine could not write that document. */
  failed(id: string, message: string): void;
  /** Whether any request is outstanding. */
  pending(): boolean;
  /** The documents requests are outstanding for. */
  waitingFor(): string[];
}

interface Outstanding {
  promise: Promise<void>;
  resolve: () => void;
  reject: (cause: Error) => void;
  timer: number;
}

const defaultClock: Clock = {
  setTimeout: (run, ms) => setTimeout(run, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createEngineSaveTracker(clock: Clock = defaultClock): EngineSaveTracker {
  const outstanding = new Map<string, Outstanding>();

  /**
   * Documents whose save gave up while the engine was still owed an answer.
   *
   * A receipt names the session, not the request — the engine posts the
   * document to `/editors/downloadas/<session>` and nothing carries a per-save
   * token — so an answer arriving after a timeout is indistinguishable from an
   * answer to whatever was asked next. Letting it settle the next request
   * marks the tab saved on the strength of bytes from before the edits that
   * followed, and closing it then throws them away.
   *
   * The marker is consumed by the first answer that arrives, or forgotten
   * after the same window the save was given: a receipt that never comes must
   * not swallow a later save's.
   */
  const abandoned = new Map<string, number>();

  function abandon(id: string, timeoutMs: number): void {
    const previous = abandoned.get(id);
    if (previous !== undefined) clock.clearTimeout(previous);
    abandoned.set(id, clock.setTimeout(() => abandoned.delete(id), timeoutMs));
  }

  /** Takes one document's request, cancelling its timeout. */
  function take(id: string): Outstanding | null {
    const stale = abandoned.get(id);
    if (stale !== undefined) {
      // This answer belongs to the save that timed out, not to whatever is
      // waiting now.
      clock.clearTimeout(stale);
      abandoned.delete(id);
      return null;
    }
    const held = outstanding.get(id);
    if (!held) return null;
    outstanding.delete(id);
    clock.clearTimeout(held.timer);
    return held;
  }

  return {
    begin(id, timeoutMs) {
      // A second save of the same document joins the first rather than
      // replacing it: the engine answers per session, so two requests for one
      // document could not be told apart, and replacing left the earlier
      // caller waiting on something nothing would ever settle.
      const already = outstanding.get(id);
      if (already) return already.promise;

      let resolve!: () => void;
      let reject!: (cause: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const timer = clock.setTimeout(() => {
        outstanding.delete(id);
        // The engine still owes an answer for this one. See `abandoned`.
        abandon(id, timeoutMs);
        reject(new Error('The editor did not answer the save in time'));
      }, timeoutMs);
      outstanding.set(id, { promise, resolve, reject, timer });
      return promise;
    },

    saved(id) {
      take(id)?.resolve();
    },

    failed(id, message) {
      take(id)?.reject(new Error(message));
    },

    pending() {
      return outstanding.size > 0;
    },

    waitingFor() {
      return [...outstanding.keys()];
    },
  };
}
