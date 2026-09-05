/**
 * Runs the viewer's document edits one at a time.
 *
 * Every edit is a tool run over the document's bytes whose result replaces the
 * document whole. Two of them in flight at once therefore both start from the
 * same bytes, and the second to finish erases the first: draw on page 1, draw
 * on page 2 before the first run comes back, and only the second stroke is in
 * the file. Nothing about it looks like a failure — the first mark is simply
 * not there.
 *
 * Serialising is what makes each edit start from what the one before it
 * produced. It also gives the viewer an honest idea of whether it is busy: the
 * count is of edits still outstanding, not of the last one to finish.
 */

export interface EditQueue {
  /** Queue `task`, resolving with its own result once every earlier one is done. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** How many edits have been queued and not yet finished. */
  readonly pending: number;
}

export function createEditQueue(): EditQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    get pending() {
      return pending;
    },

    run<T>(task: () => Promise<T>): Promise<T> {
      pending += 1;
      // `then(task, task)`: an edit that failed must not stop the next one,
      // and the queue is not the place to decide what a failure means.
      //
      // The count comes down inside the returned promise rather than on a
      // branch of it, so anything that awaits an edit sees a `pending` that is
      // already right — the viewer clears `busy` from there.
      const started = tail.then(task, task).then(
        (value) => {
          pending -= 1;
          return value as T;
        },
        (error: unknown) => {
          pending -= 1;
          throw error;
        },
      );
      tail = started.catch(() => undefined);
      return started;
    },
  };
}
