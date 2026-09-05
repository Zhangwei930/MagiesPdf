const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const settings = require('../settings.cjs');
const mainRunner = require('../jobs/mainRunner.cjs');
const { constantTimeTokenEqual, safeFileName } = require('../security.cjs');
const { InputBudget } = require('../files/inputBudget.cjs');
const {
  filterOfficeToolsForPermission,
  normalizePermissionMode,
  officeToolPermissionError,
} = require('../ai/cliPolicy.cjs');

/** Tool catalogue on disk — same file the IPC layer serves. Avoid importing ipc (Electron). */
let catalogCache = null;
function readCatalog() {
  if (catalogCache) return catalogCache;
  const catalogPath = path.join(__dirname, '..', '..', 'dist-electron', 'catalog.json');
  catalogCache = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  return catalogCache;
}

/**
 * Local REST API for MagiesPdf tools.
 *
 * Off by default. When enabled from Settings, binds loopback (or all interfaces
 * if the user opts into LAN) and requires `Authorization: Bearer <token>`.
 *
 *   GET  /v1/health
 *   GET  /v1/tools
 *   GET  /v1/tools/:id
 *   POST /v1/tools/:id   JSON body { files:[{name,bytesBase64,mime?}], params? }
 *   GET  /v1/office/workspace
 *   POST /v1/office/workspace   JSON { path }  absolute folder or document
 *   DELETE /v1/office/workspace
 *   GET  /v1/office/tools
 *   POST /v1/office/tools/:functionName   JSON body = tool arguments
 */

const MAX_BODY_BYTES = 192 * 1024 * 1024;
const MAX_FILE_BYTES = 96 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_ACTIVE_JOBS = 4;
const MAX_RETAINED_JOBS = 8;
const JOB_RETENTION_MS = 5 * 60 * 1000;

/** @type {http.Server | null} */
let server = null;
/** @type {string} */
let listenInfo = '';

function isEnabled() {
  const { api } = settings.read();
  return Boolean(api?.enabled && api?.token);
}

function resolveServerMode(api) {
  if (!api?.allowLan) return { host: '127.0.0.1', protocol: 'http' };
  if (
    typeof api.tlsCertPath !== 'string' ||
    typeof api.tlsKeyPath !== 'string' ||
    !path.isAbsolute(api.tlsCertPath) ||
    !path.isAbsolute(api.tlsKeyPath)
  ) {
    throw new Error('LAN API access requires absolute TLS certificate and private-key paths');
  }
  return {
    host: '0.0.0.0',
    protocol: 'https',
    tlsCertPath: api.tlsCertPath,
    tlsKeyPath: api.tlsKeyPath,
  };
}

function authOk(req) {
  const { token } = settings.read().api;
  if (!token) return false;
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && constantTimeTokenEqual(match[1], token));
}

/** Same AI permission mode the in-app panel uses (observer / confirm / auto). */
function currentAiPermissionMode() {
  return normalizePermissionMode(settings.read().ai?.permissionMode);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toolMeta(tool) {
  // Catalogue entries are already meta (no `run`).
  const { id, category, name, description, icon, keywords, input, output, params, runtime } = tool;
  return { id, category, name, description, icon, keywords, input, output, params, runtime };
}

function decodeBase64(value) {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Invalid base64');
  }
  return Buffer.from(value, 'base64');
}

function serializeResult(result) {
  return {
    files: (result.files || []).map((file) => ({
      name: file.name,
      mime: file.mime,
      bytesBase64: Buffer.from(file.bytes).toString('base64'),
    })),
    data: result.data,
    summary: result.summary,
  };
}

function serializeToolError(cause) {
  if (cause && typeof cause === 'object' && cause.__toolError) return cause;
  return {
    code: 'INTERNAL',
    message: cause instanceof Error ? cause.message : String(cause),
    userMessage: {
      zh: '处理失败',
      en: 'Processing failed',
    },
  };
}

/**
 * @param {{
 *   pool: import('../jobs/pool.cjs').JobPool,
 *   maxActiveJobs?: number,
 *   officeProvider?: {
 *     describeTools(): Array<Record<string, unknown>>,
 *     getWorkspaceStatus(): { configured: boolean, path: string },
 *     setWorkspaceRoot(path: string): Promise<{ configured: boolean, path: string }>,
 *     setWorkspaceFromDocumentPath(path: string): Promise<{ configured: boolean, path: string }>,
 *     clearWorkspace(): { configured: boolean, path: string },
 *     callTool(functionName: string, args: object, options?: object): Promise<unknown>,
 *     listTools?: () => Promise<Array<{ functionName: string, unattended?: boolean }>>,
 *   } | null,
 *   requestApproval?: ((request: { functionName: string, toolId: string, path: string })
 *     => Promise<boolean>) | null,
 * }} deps
 */
function createHandler({
  pool,
  maxActiveJobs = MAX_ACTIVE_JOBS,
  officeProvider = null,
  requestApproval = null,
}) {
  // Lazily constructed: host.cjs loads Electron, which node:test does not have.
  let hostBridge = null;
  const host = () => {
    if (!hostBridge) hostBridge = require('../host.cjs').createHostBridge();
    return hostBridge;
  };
  const jobs = new Map();

  /** Synchronous runs already in the pool. They cost the same as async ones. */
  let inFlightSyncRuns = 0;
  const requireOffice = () => {
    if (!officeProvider) {
      const error = new Error('Office automation is not available in this Magies Office build');
      error.status = 503;
      throw error;
    }
    return officeProvider;
  };

  const resolveWorkspacePath = async (candidate) => {
    const office = requireOffice();
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      const error = new Error('path must be an absolute directory or document path');
      error.status = 400;
      throw error;
    }
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      const error = new Error(`path does not exist: ${candidate}`);
      error.status = 400;
      throw error;
    }
    if (stat.isDirectory()) return office.setWorkspaceRoot(candidate);
    if (stat.isFile()) return office.setWorkspaceFromDocumentPath(candidate);
    const error = new Error('path must be a directory or a file');
    error.status = 400;
    throw error;
  };

  const pruneJobs = () => {
    const now = Date.now();
    for (const [jobId, job] of jobs) {
      if (job.status !== 'running' && now - (job.completedAt ?? now) > JOB_RETENTION_MS) {
        jobs.delete(jobId);
      }
    }
    for (const [jobId, job] of jobs) {
      if (jobs.size < MAX_RETAINED_JOBS) break;
      if (job.status !== 'running') jobs.delete(jobId);
    }
  };

  const runRequest = (request, runtime) =>
    runtime === 'main'
      ? mainRunner.run(request, host(), () => {})
      : pool.run(request, () => {});

  const startAsyncJob = (request, runtime) => {
    const job = { jobId: request.jobId, runtime, status: 'running' };
    jobs.set(request.jobId, job);
    void runRequest(request, runtime).then(
      (result) => {
        if (job.status === 'running') {
          job.status = 'done';
          job.result = serializeResult(result);
          job.completedAt = Date.now();
        }
      },
      (cause) => {
        if (job.status === 'running') {
          job.status = 'failed';
          job.error = serializeToolError(cause);
          job.completedAt = Date.now();
        }
      },
    );
    return job;
  };

  return async (req, res) => {
    try {
      // CORS is intentionally absent — this is a local automation surface.
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      pruneJobs();

      // Liveness needs no credentials, but the answer to "are you there" is
      // not the answer to "which build are you". With `allowLan` the server
      // binds 0.0.0.0, so naming the version here handed it to anyone on the
      // network — and this app bundles Electron, MuPDF, LibreOffice and
      // ONLYOFFICE, each with advisories a version can be looked up against.
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          service: 'MagiesPdf',
          ...(authOk(req) ? { version: require('../../package.json').version } : {}),
        });
        return;
      }

      if (!authOk(req)) {
        sendJson(res, 401, { error: 'unauthorized', message: 'Bearer token required' });
        return;
      }

      if (url.pathname === '/v1/tools' && req.method === 'GET') {
        const tools = readCatalog().tools.map(toolMeta);
        sendJson(res, 200, { tools });
        return;
      }

      // ── Office automation (LibreOffice UNO, workspace-scoped) ────────────
      if (url.pathname === '/v1/office/workspace') {
        if (req.method === 'GET') {
          sendJson(res, 200, requireOffice().getWorkspaceStatus());
          return;
        }
        if (req.method === 'DELETE') {
          sendJson(res, 200, requireOffice().clearWorkspace());
          return;
        }
        if (req.method === 'POST') {
          const raw = await readBody(req);
          let body;
          try {
            body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendJson(res, 400, { error: 'invalid_json', message: 'Body must be JSON' });
            return;
          }
          try {
            const status = await resolveWorkspacePath(body.path || body.documentPath || '');
            sendJson(res, 200, status);
          } catch (cause) {
            const status = cause && cause.status ? cause.status : 400;
            sendJson(res, status, {
              error: status === 503 ? 'unavailable' : 'invalid_input',
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
          return;
        }
      }

      if (url.pathname === '/v1/office/tools' && req.method === 'GET') {
        try {
          const office = requireOffice();
          const tools = typeof office.describeTools === 'function'
            ? office.describeTools()
            : [];
          const workspace = office.getWorkspaceStatus();
          const permissionMode = currentAiPermissionMode();
          sendJson(res, 200, {
            tools: filterOfficeToolsForPermission(tools, permissionMode),
            workspace,
            permissionMode,
          });
        } catch (cause) {
          const status = cause && cause.status ? cause.status : 500;
          sendJson(res, status, {
            error: status === 503 ? 'unavailable' : 'server_error',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
        return;
      }

      const officeToolMatch = /^\/v1\/office\/tools\/([^/]+)$/.exec(url.pathname);
      if (officeToolMatch && req.method === 'POST') {
        try {
          const office = requireOffice();
          const functionName = decodeURIComponent(officeToolMatch[1]);
          const definitions = typeof office.describeTools === 'function'
            ? office.describeTools()
            : [];
          const definition = definitions.find((entry) => entry.functionName === functionName);
          if (!definition) {
            sendJson(res, 404, { error: 'not_found', message: `Unknown Office tool: ${functionName}` });
            return;
          }
          const modeBlock = officeToolPermissionError(functionName, currentAiPermissionMode());
          if (modeBlock) {
            sendJson(res, modeBlock.status, {
              error: modeBlock.error,
              message: modeBlock.message,
            });
            return;
          }
          // An "interactive only" tool is one that must not run unwatched. It
          // used to be refused outright here, because nothing over REST could
          // ask a human. Confirm mode now asks in the AI panel, so the rule is
          // the question, not the refusal — and without a human to ask it is
          // still a no.
          if (definition.unattended === false && currentAiPermissionMode() !== 'confirm') {
            sendJson(res, 403, {
              error: 'interactive_only',
              message: `${functionName} needs a person to approve it. Switch the AI permission mode to Confirm and run it again.`,
            });
            return;
          }
          if (!office.getWorkspaceStatus().configured) {
            sendJson(res, 409, {
              error: 'workspace_required',
              message: 'Grant an Office workspace first (POST /v1/office/workspace with an absolute path)',
            });
            return;
          }

          const raw = await readBody(req);
          let args;
          try {
            args = raw.length ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            sendJson(res, 400, { error: 'invalid_json', message: 'Body must be JSON' });
            return;
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            sendJson(res, 400, { error: 'invalid_input', message: 'Body must be a JSON object of tool arguments' });
            return;
          }

          // Confirm mode has to mean confirm for callers outside this window
          // too — a CLI holding the API token is exactly who it is for.
          if (currentAiPermissionMode() === 'confirm') {
            const approved = typeof requestApproval === 'function'
              && await requestApproval({
                functionName,
                toolId: definition.toolId,
                path: typeof args.path === 'string' ? args.path : '',
              });
            if (!approved) {
              sendJson(res, 403, {
                error: 'approval_denied',
                message: `${functionName} was not approved in Magies Office. Approve it in the app, or switch the AI permission mode to Automatic.`,
              });
              return;
            }
          }

          const result = await office.callTool(functionName, args, {});
          sendJson(res, 200, {
            ok: true,
            toolId: definition.toolId,
            functionName,
            result,
          });
        } catch (cause) {
          const status = cause && cause.status ? cause.status : 422;
          sendJson(res, status, {
            error: status === 503 ? 'unavailable' : 'tool_error',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
        return;
      }

      const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
      if (jobMatch && (req.method === 'GET' || req.method === 'DELETE')) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const job = jobs.get(jobId);
        if (!job) {
          sendJson(res, 404, { error: 'not_found', message: `Unknown job: ${jobId}` });
          return;
        }
        if (req.method === 'DELETE' && job.status === 'running') {
          const cancelled =
            job.runtime === 'main' ? mainRunner.cancel(jobId) : pool.cancel(jobId);
          if (cancelled) {
            job.status = 'cancelled';
            job.completedAt = Date.now();
          }
        }
        sendJson(res, 200, job);
        return;
      }

      const toolMatch = /^\/v1\/tools\/([^/]+)$/.exec(url.pathname);
      if (toolMatch) {
        const toolId = decodeURIComponent(toolMatch[1]);
        const tool = readCatalog().tools.find((entry) => entry.id === toolId);
        if (!tool) {
          sendJson(res, 404, { error: 'not_found', message: `Unknown tool: ${toolId}` });
          return;
        }

        if (req.method === 'GET') {
          sendJson(res, 200, { tool: toolMeta(tool) });
          return;
        }

        if (req.method === 'POST') {
          // Magies "observer" blocks all PDF catalog mutations (they always write outputs).
          const catalogBlock = officeToolPermissionError(toolId, currentAiPermissionMode());
          if (catalogBlock && currentAiPermissionMode() === 'observer') {
            sendJson(res, catalogBlock.status, {
              error: catalogBlock.error,
              message: catalogBlock.message,
            });
            return;
          }
          // Both shapes count. The cap used to apply to `?async=true` alone,
          // and a synchronous POST is the same work in the same pool — an
          // authenticated caller could open any number of them, each carrying
          // up to 128 MB of files, and the queue behind them is unbounded.
          const running = [...jobs.values()].filter((job) => job.status === 'running').length;
          if (running + inFlightSyncRuns >= maxActiveJobs) {
            sendJson(res, 429, {
              error: 'too_many_jobs',
              message: `At most ${maxActiveJobs} tool runs may be in flight at once`,
            });
            return;
          }
          // Taken before the body is read, not after it. Reading an upload
          // takes as long as the upload takes, and a cap checked before the
          // read and claimed after it is no cap at all: every request passes
          // the check while the first one is still arriving, each carrying up
          // to 128 MB. Held until the handler is done with this request —
          // including the synchronous run, and released once an async job has
          // been registered, because `jobs` counts that one instead.
          inFlightSyncRuns += 1;
          try {
            const raw = await readBody(req);
            let body;
            try {
              body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
            } catch {
              sendJson(res, 400, { error: 'invalid_json', message: 'Body must be JSON' });
              return;
            }

            const filesIn = Array.isArray(body.files) ? body.files : [];
            if (filesIn.length === 0) {
              sendJson(res, 400, { error: 'invalid_input', message: 'files[] is required' });
              return;
            }

            const files = [];
            const budget = new InputBudget({
              maxFileBytes: MAX_FILE_BYTES,
              maxTotalBytes: MAX_TOTAL_FILE_BYTES,
              maxFiles: MAX_FILES,
            });
            for (const entry of filesIn) {
              if (!entry || typeof entry.name !== 'string' || typeof entry.bytesBase64 !== 'string') {
                sendJson(res, 400, {
                  error: 'invalid_input',
                  message: 'Each file needs name and bytesBase64',
                });
                return;
              }
              let buffer;
              try {
                safeFileName(entry.name);
              } catch {
                sendJson(res, 400, {
                  error: 'invalid_input',
                  message: 'Each file name must be a plain name without a path',
                });
                return;
              }
              try {
                buffer = decodeBase64(entry.bytesBase64);
              } catch {
                sendJson(res, 400, {
                  error: 'invalid_input',
                  message: `Bad base64 for ${entry.name}`,
                });
                return;
              }
              try {
                budget.add(buffer.length);
              } catch (cause) {
                sendJson(res, 413, {
                  error: 'input_too_large',
                  message: cause instanceof Error ? cause.message : String(cause),
                });
                return;
              }
              // Own the bytes: Buffer views often sit on a pooled ArrayBuffer that
              // worker_threads refuse to transfer ("unsupported type").
              const owned = new Uint8Array(buffer.length);
              owned.set(buffer);
              files.push({
                name: entry.name,
                bytes: owned,
                mime: typeof entry.mime === 'string' ? entry.mime : 'application/octet-stream',
              });
            }

            const request = {
              jobId: randomUUID(),
              toolId,
              files,
              params: body.params && typeof body.params === 'object' ? body.params : {},
            };

            const runtime = tool.runtime ?? 'worker';
            if (url.searchParams.get('async') === 'true') {
              startAsyncJob(request, runtime);
              sendJson(res, 202, { jobId: request.jobId, status: 'running' });
              return;
            }
            try {
              const result = await runRequest(request, runtime);
              sendJson(res, 200, serializeResult(result));
            } catch (cause) {
              // Worker pool rejects with SerializedToolError; mainRunner does too.
              const err = serializeToolError(cause);
              sendJson(res, 422, {
                error: 'tool_error',
                code: err.code,
                message: err.message,
                userMessage: err.userMessage,
                details: err.details,
              });
            }
            return;
          } finally {
            inFlightSyncRuns -= 1;
          }
        }
      }

      sendJson(res, 404, { error: 'not_found', message: 'No such route' });
    } catch (cause) {
      const status = cause && cause.status ? cause.status : 500;
      sendJson(res, status, {
        error: 'server_error',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
}

/**
 * Start or restart the API to match current settings. Safe to call repeatedly.
 * @param {{
 *   pool: import('../jobs/pool.cjs').JobPool,
 *   officeProvider?: object | null,
 * }} deps
 */
async function syncApiServer(deps) {
  await stopApiServer();

  if (!isEnabled()) {
    listenInfo = '';
    return { running: false, address: '' };
  }

  const { api } = settings.read();
  const mode = resolveServerMode(api);
  const host = mode.host;
  const port = Number(api.port) || 8737;

  return new Promise((resolve, reject) => {
    const handler = createHandler(deps);
    server =
      mode.protocol === 'https'
        ? https.createServer(
            {
              cert: fs.readFileSync(mode.tlsCertPath),
              key: fs.readFileSync(mode.tlsKeyPath),
            },
            handler,
          )
        : http.createServer(handler);
    server.once('error', (error) => {
      server = null;
      listenInfo = '';
      reject(error);
    });
    server.listen(port, host, () => {
      const address = server.address();
      listenInfo =
        typeof address === 'object' && address
          ? `${mode.protocol}://${host}:${address.port}`
          : `${mode.protocol}://${host}:${port}`;
      console.log(`[magiespdf] REST API listening on ${listenInfo}`);
      resolve({ running: true, address: listenInfo });
    });
  });
}

function stopApiServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const current = server;
    server = null;
    listenInfo = '';
    current.close(() => resolve());
  });
}

function getApiStatus() {
  return {
    running: Boolean(server),
    address: listenInfo,
    enabled: isEnabled(),
  };
}

module.exports = {
  syncApiServer,
  stopApiServer,
  getApiStatus,
  createHandler,
  isEnabled,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  MAX_TOTAL_FILE_BYTES,
  MAX_FILES,
  MAX_ACTIVE_JOBS,
  MAX_RETAINED_JOBS,
  resolveServerMode,
};
