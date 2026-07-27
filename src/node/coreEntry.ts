/**
 * The engine as a library, for the Electron main process.
 *
 * `worker.ts` wraps this same core in a worker-thread message loop; the main
 * process instead imports it directly (via dynamic import from CJS) to run
 * `runtime: 'main'` tools with the host bridge. One build, two consumers.
 */
import { registerAllTools } from '../core/tools/index.ts';

registerAllTools();

export { registry } from '../core/tools/index.ts';
export { executeTool } from '../core/execute.ts';
export { ToolError, toToolError } from '../core/errors.ts';
