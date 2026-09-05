import { executeTool, type ExecuteOptions } from './execute.ts';
import type { ToolDescriptor, ToolResult } from './types.ts';

/**
 * Runs one tool from inside another.
 *
 * `advanced.batch` and `advanced.pipeline` are `runtime: 'main'` because a
 * step *might* need the host — Chromium's print pipeline, the external
 * converter. Most steps need neither, and running them inline meant the main
 * process did their work: a batch over large files froze the window, its own
 * cancel button, the editor and the local API for as long as it took.
 *
 * So a step that does not need the host is handed back to the host to run
 * somewhere else. A step that does, and any host that cannot dispatch, runs
 * here exactly as before — a `runtime: 'main'` tool sent to a worker would
 * find no `printToPDF` and no converter there.
 */
export async function runSubTool(
  tool: ToolDescriptor,
  options: ExecuteOptions,
): Promise<ToolResult> {
  const dispatch = tool.runtime !== 'main' ? options.host?.runTool : undefined;
  if (!dispatch) return executeTool(tool, options);

  return dispatch.call(
    options.host,
    tool.id,
    options.files,
    options.params,
    options.signal,
    options.onProgress,
  );
}
