const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createEditorHost } = require('./editorHost.cjs');
const { obfuscateFont } = require('./editorAssets.cjs');
const { editorAssetsRoot } = require('./engine.cjs');

/**
 * The Electron side of the embedded editor: a loopback server and the font
 * protocol, wired into `createEditorHost`.
 *
 * Both are thin on purpose — every decision worth testing lives in
 * `editorHost`, `editorAssets` and `editorHandshake`, which know nothing about
 * Electron or sockets.
 */

const CONTENT_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
}));

function contentType(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * How long Chromium may keep an editor asset.
 *
 * Session pages and document bytes change every open. The engine's scripts,
 * styles and fonts do not for the life of a running app — caching them is what
 * makes the second open (and every tab after warm-up) much faster than the first.
 */
function cacheControlFor(pathname) {
  if (
    pathname.startsWith('/editor/')
    || pathname.startsWith('/session/')
    || pathname.startsWith('/media/')
    || pathname.includes('/downloadas/')
    || pathname.endsWith('socket.io.min.js')
  ) {
    return 'no-store';
  }
  return 'public, max-age=31536000, immutable';
}

/** Serves `handle`'s answers over loopback on a port the OS picks. */
/** `…/editor/<sessionId>` — the frame a request came from, or nothing. */
function sessionFromReferer(request) {
  const referer = request.headers?.referer || request.headers?.referrer;
  if (typeof referer !== 'string' || referer === '') return undefined;
  try {
    const match = /\/editor\/([^/?#]+)/.exec(new URL(referer).pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function listenLoopback(handle) {
  return new Promise((resolve, reject) => {
    /**
     * Answers one request. Every throw inside it is caught by the wrapper
     * below — an `async` listener handed straight to `createServer` turns a
     * failed save into a promise nobody holds, and a request the engine waits
     * on forever behind its progress dialog.
     */
    const serve = async (request, response) => {
      let url;
      try {
        url = new URL(request.url, 'http://127.0.0.1');
      } catch {
        response.writeHead(400).end();
        return;
      }

      // Only an upload has a body, and only it needs the command that says
      // where in the sequence its chunk falls.
      let body;
      let command;
      if (request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        body = Buffer.concat(chunks);
        try {
          command = JSON.parse(url.searchParams.get('cmd') ?? '{}');
        } catch {
          command = {};
        }
      }

      const answer = await handle({
        path: url.pathname,
        method: request.method,
        // The engine asks for a document's images by the key they had in the
        // document map — `/media/image1.png` — with no session anywhere in the
        // path. The frame that asked does carry one, in its own url, so the
        // referrer is what says which document the image belongs to. Without
        // it every such request fell back to whichever session was last
        // focused, and two documents each holding an `image1.png` could be
        // served each other's.
        session: url.searchParams.get('session') ?? sessionFromReferer(request) ?? undefined,
        body,
        command,
      });

      if (process.env.MAGIES_EDITOR_TRACE) {
        const size = body ? ` ${body.length} bytes` : '';
        console.log('[editor]', answer.status, url.pathname + size);
      }
      if (answer.status !== 200) {
        response.writeHead(answer.status).end();
        return;
      }
      const cache = { 'Cache-Control': cacheControlFor(url.pathname) };
      if (answer.body !== undefined) {
        response.writeHead(200, { 'Content-Type': answer.type, ...cache });
        response.end(answer.body);
        return;
      }
      let stat;
      try {
        stat = fs.statSync(answer.file);
      } catch {
        if (process.env.MAGIES_EDITOR_TRACE) console.log('[editor] 404', url.pathname, '->', answer.file);
        response.writeHead(404).end();
        return;
      }
      if (!stat.isFile()) {
        response.writeHead(404).end();
        return;
      }
      // Fonts are rewritten on the way out, so they are read rather than
      // streamed. They are a few hundred kilobytes each and the engine caches
      // them, so this is not the path worth streaming.
      if (answer.font) {
        const body = obfuscateFont(fs.readFileSync(answer.file));
        response.writeHead(200, {
          'Content-Type': contentType(answer.file),
          'Content-Length': body.length,
          ...cache,
        });
        response.end(body);
        return;
      }

      response.writeHead(200, {
        'Content-Type': contentType(answer.file),
        'Content-Length': stat.size,
        ...cache,
      });
      fs.createReadStream(answer.file).pipe(response);
    };

    const server = http.createServer((request, response) => {
      void serve(request, response).catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (process.env.MAGIES_EDITOR_TRACE) {
          console.error('[editor] 500', request.url, message);
        }
        // Headers already out means a body was being streamed; there is no
        // status left to change, so end it rather than leave it hanging.
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'editor_host_failed', message }));
      });
    });

    server.once('error', reject);
    // Loopback only: this exists for one renderer, not for the network.
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function createEditorRuntime({ projectRoot, onDocumentSaved } = {}) {
  return createEditorHost({
    editorsRoot: editorAssetsRoot({ projectRoot }),
    listen: listenLoopback,
    onDocumentSaved,
  });
}

module.exports = {
  createEditorRuntime,
  listenLoopback,
  sessionFromReferer,
  contentType,
  cacheControlFor,
};
