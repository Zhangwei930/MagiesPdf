const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createEditorHost } = require('./editorHost.cjs');
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

/** Serves `handle`'s answers over loopback on a port the OS picks. */
function listenLoopback(handle) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
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
        session: url.searchParams.get('session') ?? undefined,
        body,
        command,
      });

      if (process.env.MAGIES_EDITOR_TRACE) console.log('[editor]', answer.status, url.pathname);
      if (answer.status !== 200) {
        response.writeHead(answer.status).end();
        return;
      }
      if (answer.body !== undefined) {
        response.writeHead(200, { 'Content-Type': answer.type });
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
      response.writeHead(200, {
        'Content-Type': contentType(answer.file),
        'Content-Length': stat.size,
      });
      fs.createReadStream(answer.file).pipe(response);
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

module.exports = { createEditorRuntime, listenLoopback, contentType };
