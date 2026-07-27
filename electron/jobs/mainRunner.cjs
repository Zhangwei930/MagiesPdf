const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Executes `runtime: 'main'` tools in the main process.
 *
 * These tools need capabilities only the main process has (Chromium's
 * printToPDF, the external converter), so they cannot go through the worker
 * pool. The engine itself still comes from the same `src/core` build the
 * workers use — `dist-electron/core.mjs` — so validation, errors and results
 * behave identically on both paths.
 */

const CORE_ENTRY = path.join(__dirname, '..', '..', 'dist-electron', 'core.mjs');

let corePromise = null;

function loadCore() {
  // CJS cannot require ESM; a cached dynamic import is the supported bridge.
  if (!corePromise) corePromise = import(pathToFileURL(CORE_ENTRY).href);
  return corePromise;
}

/** jobId -> AbortController for cancellation parity with the worker pool. */
const running = new Map();

async function run(request, host, onProgress) {
  const controller = new AbortController();
  running.set(request.jobId, controller);
  let serializeToolError = null;

  try {
    const { registry, executeTool, toToolError } = await loadCore();
    serializeToolError = (cause) => toToolError(cause).toJSON();
    const tool = registry.get(request.toolId);
    const result = await executeTool(tool, {
      files: request.files,
      params: request.params,
      signal: controller.signal,
      host,
      onProgress,
    });
    return { files: result.files, data: result.data, summary: result.summary };
  } catch (cause) {
    // Reject with the same serialised shape the worker pool produces.
    if (serializeToolError) throw serializeToolError(cause);
    throw {
      __toolError: true,
      code: 'INTERNAL',
      message: cause instanceof Error ? cause.message : String(cause),
      userMessage: {
        zh: '主进程工具加载失败。',
        en: 'The main-process tool failed to load.',
      },
    };
  } finally {
    running.delete(request.jobId);
  }
}

function cancel(jobId) {
  const controller = running.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}

module.exports = { run, cancel, loadCore, CORE_ENTRY };
