const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cacheControlFor, listenLoopback } = require('./editorRuntime.cjs');

describe('editor HTTP cache', () => {
  it('never caches session pages or document bytes', () => {
    assert.equal(cacheControlFor('/editor/abc'), 'no-store');
    assert.equal(cacheControlFor('/session/abc/Editor.bin'), 'no-store');
    assert.equal(cacheControlFor('/media/image1.png'), 'no-store');
    assert.equal(cacheControlFor('/editors/downloadas/abc'), 'no-store');
    assert.equal(cacheControlFor('/editors/web-apps/vendor/socketio/socket.io.min.js'), 'no-store');
  });

  it('caches engine scripts and fonts for the life of the app', () => {
    assert.match(cacheControlFor('/editors/sdkjs/word/sdk-all-min.js'), /max-age=/);
    assert.match(cacheControlFor('/editors/sdkjs/common/AllFonts.js'), /immutable/);
    assert.match(cacheControlFor('/editors/web-apps/apps/documenteditor/main/code.js'), /max-age=/);
  });
});

/**
 * The loopback listener is an `async` function handed to `http.createServer`,
 * so anything `handle` throws becomes a rejected promise nobody is holding.
 * The response is never written, which leaves the engine behind its progress
 * dialog forever, and node reports an unhandled rejection — from a save that
 * failed for an ordinary reason: a full disk, a read-only file, a converter
 * that quit. See issue #23.
 */
describe('editor host error handling', () => {
  async function withServer(handle, fn) {
    const server = await listenLoopback(handle);
    try {
      return await fn(server.port);
    } finally {
      await server.close();
    }
  }

  /**
   * Every request here carries a deadline. The failure being tested *is* a
   * request that never gets an answer, so without one the suite would hang
   * rather than fail — in CI that is a stuck job, not a red test.
   */
  const REPLY_DEADLINE_MS = 2000;

  async function get(port, path = '/anything', init = {}) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REPLY_DEADLINE_MS),
      });
    } catch (cause) {
      if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
        assert.fail(`no reply within ${REPLY_DEADLINE_MS}ms — the request was left open`);
      }
      throw cause;
    }
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  }

  it('answers 500 when the handler throws instead of leaving the request open', async () => {
    await withServer(
      async () => {
        throw new Error('ENOSPC: no space left on device');
      },
      async (port) => {
        const response = await get(port);
        assert.equal(response.status, 500);
        assert.match(response.type, /application\/json/);
        assert.match(response.body, /no space left on device/);
      },
    );
  });

  it('answers 500 when the handler rejects on a POST, which is what a save is', async () => {
    await withServer(
      async ({ method }) => {
        if (method === 'POST') throw new Error('EACCES: permission denied');
        return { status: 200, body: 'ok', type: 'text/plain' };
      },
      async (port) => {
        const response = await get(port, '/editors/downloadas/s1?session=s1', {
          method: 'POST',
          body: 'document-bytes',
        });
        assert.equal(response.status, 500);
        assert.match(response.body, /permission denied/);
      },
    );
  });

  it('reports no unhandled rejection when a handler throws', async () => {
    const seen = [];
    const record = (reason) => seen.push(reason);
    process.on('unhandledRejection', record);
    try {
      await withServer(
        async () => {
          throw new Error('converter exited with code 1');
        },
        async (port) => {
          await get(port);
          // Give the microtask queue a chance to surface a stray rejection.
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      );
    } finally {
      process.off('unhandledRejection', record);
    }
    assert.deepEqual(seen, []);
  });

  it('still serves a normal answer', async () => {
    await withServer(
      async () => ({ status: 200, body: 'served', type: 'text/plain' }),
      async (port) => {
        const response = await get(port);
        assert.equal(response.status, 200);
        assert.equal(response.body, 'served');
      },
    );
  });
});
