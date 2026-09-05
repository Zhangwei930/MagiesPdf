'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Lets a `runtime: 'main'` tool hand one of its steps back to the worker pool.
 *
 * `advanced.batch` and `advanced.pipeline` have to run in the main process,
 * because a step might need the host bridge — Chromium's print pipeline, the
 * external converter. Most steps need neither, and doing their work here means
 * the window stops drawing, the run's own cancel button stops answering, and
 * the embedded editor and the local API stop with them until it finishes.
 *
 * Every entry point that owns a pool has to install this. Wiring it into the
 * desktop path alone left a batch started over the REST API doing exactly what
 * it used to.
 *
 * @param {import('./pool.cjs').JobPool} pool
 * @param {() => string} [uniqueId] injectable so tests can name jobs
 */
function poolDispatcher(pool, uniqueId = () => randomUUID()) {
  return (toolId, files, params, signal, onProgress) => {
    const jobId = uniqueId();
    // Cancelling the run has to reach the step that is actually running, and
    // stop reaching it once that step is done.
    const abort = () => void pool.cancel(jobId);
    signal?.addEventListener('abort', abort, { once: true });

    return pool
      .run({ jobId, toolId, files, params }, (fraction, message) => {
        onProgress?.(fraction, message);
      })
      .finally(() => signal?.removeEventListener('abort', abort));
  };
}

module.exports = { poolDispatcher };
