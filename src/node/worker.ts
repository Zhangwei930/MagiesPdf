import { parentPort } from 'node:worker_threads';
import { ToolError, toToolError } from '../core/errors.ts';
import { executeTool } from '../core/execute.ts';
import type { WorkerInbound, WorkerOutbound } from '../core/protocol.ts';
import { transferablesOf } from '../core/protocol.ts';
import { registerAllTools, registry } from '../core/tools/index.ts';

/**
 * Worker-thread entry point.
 *
 * One worker runs one job at a time; the pool in `electron/jobs/pool.cjs` owns
 * scheduling. Keeping the thread single-job means a cancel can simply flip the
 * abort controller, and a crashed job takes down only its own worker.
 */

registerAllTools();

/** Narrows `parentPort` once, so the handlers below do not each re-check it. */
function requirePort(): NonNullable<typeof parentPort> {
  if (!parentPort) throw new Error('worker.mjs must be started as a worker thread');
  return parentPort;
}

const port = requirePort();

/** Abort controllers for jobs currently running in this thread. */
const running = new Map<string, AbortController>();

function post(message: WorkerOutbound, transfer: ArrayBuffer[] = []): void {
  port.postMessage(message, transfer);
}

async function runJob(message: Extract<WorkerInbound, { type: 'run' }>): Promise<void> {
  const { jobId, toolId, files, params } = message;
  const controller = new AbortController();
  running.set(jobId, controller);

  try {
    const tool = registry.get(toolId);

    if (tool.runtime === 'main') {
      throw new ToolError('HOST_UNAVAILABLE', `${toolId} must run on the main thread`, {
        zh: `「${tool.name.zh}」需要主进程能力，无法在后台线程运行。`,
        en: `"${tool.name.en}" needs main-process capabilities and cannot run in a worker.`,
      });
    }

    const result = await executeTool(tool, {
      files,
      params,
      signal: controller.signal,
      onProgress: (fraction, msgText) =>
        post({ type: 'progress', jobId, fraction, message: msgText }),
    });

    post(
      { type: 'done', jobId, files: result.files, data: result.data, summary: result.summary },
      transferablesOf(result.files),
    );
  } catch (cause) {
    post({ type: 'error', jobId, error: toToolError(cause).toJSON() });
  } finally {
    running.delete(jobId);
  }
}

port.on('message', (message: WorkerInbound) => {
  switch (message.type) {
    case 'run':
      void runJob(message);
      break;
    case 'cancel':
      running.get(message.jobId)?.abort();
      break;
  }
});

// A tool throwing outside the awaited chain must not take the pool down silently.
process.on('unhandledRejection', (reason) => {
  console.error('[magiespdf:worker] unhandled rejection', reason);
});
