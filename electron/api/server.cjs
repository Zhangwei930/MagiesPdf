const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const settings = require('../settings.cjs');
const mainRunner = require('../jobs/mainRunner.cjs');
const { constantTimeTokenEqual, safeFileName } = require('../security.cjs');
const { InputBudget } = require('../files/inputBudget.cjs');

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
 *   maxActiveJobs?: number
 * }} deps
 */
function createHandler({ pool, maxActiveJobs = MAX_ACTIVE_JOBS }) {
  // Lazily constructed: host.cjs loads Electron, which node:test does not have.
  let hostBridge = null;
  const host = () => {
    if (!hostBridge) hostBridge = require('../host.cjs').createHostBridge();
    return hostBridge;
  };
  const jobs = new Map();

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

      if (url.pathname === '/v1/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, service: 'MagiesPdf', version: require('../../package.json').version });
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
          if (
            url.searchParams.get('async') === 'true' &&
            [...jobs.values()].filter((job) => job.status === 'running').length >= maxActiveJobs
          ) {
            sendJson(res, 429, {
              error: 'too_many_jobs',
              message: `At most ${maxActiveJobs} asynchronous jobs may run at once`,
            });
            return;
          }
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
 * @param {{ pool: import('../jobs/pool.cjs').JobPool }} deps
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
