const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it } = require('node:test');
const { cacheControlFor, listenLoopback, sessionFromReferer } = require('./editorRuntime.cjs');

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
/**
 * Quitting now awaits the host (issue #29), which is only safe because
 * `server.close()` hangs up idle keep-alive sockets instead of waiting for
 * them — node has done that since 19, and the editor keeps such sockets open
 * for as long as its frame is alive. This pins that assumption: if it ever
 * stops holding, the symptom is a window that will not close, which is a
 * miserable thing to diagnose from a bug report.
 */
describe('stopping the editor host', () => {
  it('closes while a client is still holding a keep-alive connection', async () => {
    const server = await listenLoopback(async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('ok');
    });
    const agent = new http.Agent({ keepAlive: true });

    await new Promise((resolve, reject) => {
      const request = http.get(
        { host: '127.0.0.1', port: server.port, path: '/anything', agent },
        (response) => {
          response.resume();
          response.on('end', resolve);
        },
      );
      request.on('error', reject);
    });

    let deadline;
    try {
      await Promise.race([
        server.close(),
        new Promise((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error('close() never returned — a kept-alive socket holds the port')),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      agent.destroy();
    }
  });
});

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

/**
 * Every Office tab keeps its frame mounted, and the engine asks for a
 * document's images by the key they had in the document map —
 * `/media/image1.png` — with no session anywhere in the path. Falling back to
 * whichever session was last focused meant two documents that each hold an
 * `image1.png` could be served each other's, and a background tab finishing
 * its load could pick up the foreground document's picture.
 *
 * The frame that asked carries the session in its own url.
 */
describe('which document an image request belongs to', () => {
  const asked = (referer) => sessionFromReferer({ headers: referer ? { referer } : {} });

  it('reads the session out of the asking frame', () => {
    assert.equal(asked('http://127.0.0.1:51234/editor/sess-a'), 'sess-a');
    assert.equal(asked('http://127.0.0.1:51234/editor/sess-b?x=1'), 'sess-b');
  });

  it('answers nothing when there is nothing to read', () => {
    assert.equal(asked(''), undefined);
    assert.equal(asked('not a url'), undefined);
    assert.equal(asked('http://127.0.0.1:51234/editors/sdkjs/word/sdk-all-min.js'), undefined);
  });

  it('decodes a session that had to be escaped', () => {
    assert.equal(asked('http://127.0.0.1:9/editor/a%2Fb'), 'a/b');
  });

  /**
   * The outer page is `/editor/<session>`, but the engine runs in a frame
   * *inside* it whose url the engine builds itself:
   * `/editors/web-apps/apps/documenteditor/main/index.html?...`. Nothing in
   * that path says which document it is, so every request the engine makes —
   * its images, its socket stub — fell back to whichever session was last
   * focused. Two documents open, and one could be served the other's picture,
   * or a socket stub naming the other's `Editor.bin`.
   *
   * ONLYOFFICE carries the placeholder element's id into that url as
   * `frameEditorId`, so making the placeholder's id name the session puts the
   * session back into the referer.
   */
  it('reads the session out of the engine\'s own frame url', () => {
    assert.equal(
      asked('http://127.0.0.1:51234/editors/web-apps/apps/documenteditor/main/index.html?_dc=1&frameEditorId=editor-sess-a&lang=en'),
      'sess-a',
    );
    assert.equal(
      asked('http://127.0.0.1:51234/editors/web-apps/apps/spreadsheeteditor/main/index.html?frameEditorId=editor-sess-b'),
      'sess-b',
    );
  });

  it('takes an explicit session in the referer over anything else', () => {
    assert.equal(asked('http://127.0.0.1:9/anything?session=sess-c'), 'sess-c');
  });

  it('ignores a frame id that is not one of ours', () => {
    assert.equal(asked('http://127.0.0.1:9/x?frameEditorId=editor'), undefined);
    assert.equal(asked('http://127.0.0.1:9/x?frameEditorId=somebody-else'), undefined);
  });

  it('is only a fallback — an explicit session still wins', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'editorRuntime.cjs'),
      'utf8',
    );
    assert.match(source, /searchParams\.get\('session'\) \?\? sessionFromReferer/);
  });
});
