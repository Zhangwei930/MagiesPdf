const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const settings = require('../settings.cjs');
const mainRunner = require('../jobs/mainRunner.cjs');

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

const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** @type {http.Server | null} */
let server = null;
/** @type {string} */
let listenInfo = '';

function isEnabled() {
  const { api } = settings.read();
  return Boolean(api?.enabled && api?.token);
}

function authOk(req) {
  const { token } = settings.read().api;
  if (!token) return false;
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && match[1] === token);
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

/**
 * @param {{ pool: import('../jobs/pool.cjs').JobPool }} deps
 */
function createHandler({ pool }) {
  // Lazily constructed: host.cjs loads Electron, which node:test does not have.
  let hostBridge = null;
  const host = () => {
    if (!hostBridge) hostBridge = require('../host.cjs').createHostBridge();
    return hostBridge;
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
              buffer = Buffer.from(entry.bytesBase64, 'base64');
            } catch {
              sendJson(res, 400, { error: 'invalid_input', message: `Bad base64 for ${entry.name}` });
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
          try {
            const result =
              runtime === 'main'
                ? await mainRunner.run(request, host(), () => {})
                : await pool.run(request, () => {});

            sendJson(res, 200, {
              files: (result.files || []).map((file) => ({
                name: file.name,
                mime: file.mime,
                bytesBase64: Buffer.from(file.bytes).toString('base64'),
              })),
              data: result.data,
              summary: result.summary,
            });
          } catch (cause) {
            // Worker pool rejects with SerializedToolError; mainRunner does too.
            const err =
              cause && typeof cause === 'object' && cause.__toolError
                ? cause
                : {
                    code: 'INTERNAL',
                    message: cause instanceof Error ? cause.message : String(cause),
                    userMessage: {
                      zh: '处理失败',
                      en: 'Processing failed',
                    },
                  };
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
  const host = api.allowLan ? '0.0.0.0' : '127.0.0.1';
  const port = Number(api.port) || 8737;

  return new Promise((resolve, reject) => {
    server = http.createServer(createHandler(deps));
    server.once('error', (error) => {
      server = null;
      listenInfo = '';
      reject(error);
    });
    server.listen(port, host, () => {
      const address = server.address();
      listenInfo =
        typeof address === 'object' && address
          ? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`
          : `http://127.0.0.1:${port}`;
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
};
