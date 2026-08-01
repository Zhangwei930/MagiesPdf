'use strict';

function createJobExecutor({ tools, pool, mainRunner, hostBridge }) {
  const runtimes = new Map(tools.map((tool) => [tool.id, tool.runtime || 'worker']));

  const runtimeOf = (toolId) => {
    const runtime = runtimes.get(toolId);
    if (!runtime) throw new Error(`Unknown tool "${toolId}"`);
    return runtime;
  };

  const cancel = (jobId) => pool.cancel(jobId) || mainRunner.cancel(jobId);

  const run = async (request, onProgress = () => {}, signal) => {
    if (signal?.aborted) {
      const error = new Error('Job cancelled before it started');
      error.name = 'AbortError';
      throw error;
    }
    const onAbort = () => cancel(request.jobId);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return runtimeOf(request.toolId) === 'main'
        ? await mainRunner.run(request, hostBridge, onProgress)
        : await pool.run(request, onProgress);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };

  return { cancel, run, runtimeOf };
}

module.exports = { createJobExecutor };
