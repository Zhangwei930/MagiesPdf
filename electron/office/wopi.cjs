const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { isOfficeDocumentPath } = require('./formats.cjs');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOCK_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 20;
const MAX_WOPI_FILE_BYTES = 512 * 1024 * 1024;

function tokensEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function createWopiStore(deps = {}) {
  const runtime = {
    fs: deps.fs ?? fs,
    now: deps.now ?? Date.now,
    id: deps.id ?? randomUUID,
    token: deps.token ?? (() => randomBytes(32).toString('base64url')),
  };
  const sessions = new Map();

  function pruneExpired() {
    const now = runtime.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
  }

  function makeRoom() {
    pruneExpired();
    while (sessions.size >= MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
  }

  function authorize(id, accessToken) {
    pruneExpired();
    const session = sessions.get(id);
    if (!session || !tokensEqual(session.accessToken, accessToken)) {
      throw Object.assign(new Error('Unauthorized WOPI session'), { status: 401 });
    }
    if (session.lock && session.lockExpiresAt <= runtime.now()) {
      session.lock = '';
      session.lockExpiresAt = 0;
    }
    return session;
  }

  return {
    async register(filePath) {
      if (!path.isAbsolute(filePath) || !isOfficeDocumentPath(filePath)) {
        throw new Error('An absolute supported Office document path is required');
      }
      const stat = await runtime.fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
      makeRoom();
      const session = {
        id: runtime.id(),
        accessToken: runtime.token(),
        filePath,
        expiresAt: runtime.now() + SESSION_TTL_MS,
        lock: '',
        lockExpiresAt: 0,
      };
      sessions.set(session.id, session);
      return {
        id: session.id,
        accessToken: session.accessToken,
        accessTokenTtl: session.expiresAt,
      };
    },

    async info(id, accessToken) {
      const session = authorize(id, accessToken);
      const stat = await runtime.fs.stat(session.filePath);
      return {
        BaseFileName: path.basename(session.filePath),
        OwnerId: 'local-owner',
        Size: stat.size,
        Version: `${stat.mtimeMs}-${stat.size}`,
        LastModifiedTime: stat.mtime.toISOString(),
        UserCanWrite: true,
        SupportsLocks: true,
        SupportsUpdate: true,
        UserId: 'local-user',
        UserFriendlyName: 'Local user',
      };
    },

    async read(id, accessToken) {
      return runtime.fs.readFile(authorize(id, accessToken).filePath);
    },

    async write(id, accessToken, bytes, lock) {
      const session = authorize(id, accessToken);
      if (session.lock && session.lock !== lock) {
        throw Object.assign(new Error('WOPI lock mismatch'), {
          status: 409,
          currentLock: session.lock,
        });
      }
      await runtime.fs.writeFile(session.filePath, bytes);
      return this.info(id, accessToken);
    },

    lock(id, accessToken, lock) {
      const session = authorize(id, accessToken);
      if (!lock) throw Object.assign(new Error('A WOPI lock value is required'), { status: 400 });
      if (session.lock && session.lock !== lock) {
        return { ok: false, currentLock: session.lock };
      }
      session.lock = lock;
      session.lockExpiresAt = runtime.now() + LOCK_TTL_MS;
      return { ok: true, currentLock: lock };
    },

    unlock(id, accessToken, lock) {
      const session = authorize(id, accessToken);
      if (session.lock && session.lock !== lock) {
        return { ok: false, currentLock: session.lock };
      }
      session.lock = '';
      session.lockExpiresAt = 0;
      return { ok: true, currentLock: '' };
    },

    currentLock(id, accessToken) {
      return authorize(id, accessToken).lock;
    },
  };
}

const wopiStore = createWopiStore();

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_WOPI_FILE_BYTES) {
        reject(Object.assign(new Error('WOPI file is too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function createWopiHandler(store = wopiStore) {
  return async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const match = /^\/wopi\/files\/([^/]+)(\/contents)?$/.exec(url.pathname);
    if (!match) return false;

    const id = decodeURIComponent(match[1]);
    const contents = match[2] === '/contents';
    const accessToken = url.searchParams.get('access_token') ?? '';
    const lock = request.headers['x-wopi-lock'] ?? '';

    try {
      if (request.method === 'GET' && contents) {
        const bytes = await store.read(id, accessToken);
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.length,
          'Cache-Control': 'no-store',
        });
        response.end(bytes);
        return true;
      }
      if (request.method === 'GET' && !contents) {
        sendJson(response, 200, await store.info(id, accessToken));
        return true;
      }
      if (request.method === 'POST' && contents) {
        const info = await store.write(id, accessToken, await readRequestBody(request), lock);
        sendJson(response, 200, { LastModifiedTime: info.LastModifiedTime });
        return true;
      }
      if (request.method === 'POST' && !contents) {
        const operation = String(request.headers['x-wopi-override'] ?? '').toUpperCase();
        let result;
        if (operation === 'LOCK' || operation === 'REFRESH_LOCK') {
          result = store.lock(id, accessToken, lock);
        } else if (operation === 'UNLOCK') {
          result = store.unlock(id, accessToken, lock);
        } else if (operation === 'GET_LOCK') {
          result = { ok: true, currentLock: store.currentLock(id, accessToken) };
        } else {
          sendJson(response, 501, { error: 'unsupported_operation' });
          return true;
        }
        if (!result.ok) {
          sendJson(response, 409, { error: 'lock_mismatch' }, { 'X-WOPI-Lock': result.currentLock });
          return true;
        }
        response.writeHead(200, result.currentLock ? { 'X-WOPI-Lock': result.currentLock } : {});
        response.end();
        return true;
      }
      sendJson(response, 405, { error: 'method_not_allowed' });
    } catch (cause) {
      const status = cause && typeof cause.status === 'number' ? cause.status : 500;
      const headers = cause?.currentLock ? { 'X-WOPI-Lock': cause.currentLock } : {};
      sendJson(
        response,
        status,
        { error: status === 401 ? 'unauthorized' : 'wopi_error' },
        headers,
      );
    }
    return true;
  };
}

module.exports = {
  createWopiHandler,
  createWopiStore,
  wopiStore,
  LOCK_TTL_MS,
  MAX_SESSIONS,
  SESSION_TTL_MS,
  MAX_WOPI_FILE_BYTES,
};
