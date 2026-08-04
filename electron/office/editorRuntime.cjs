const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createEditorHost } = require('./editorHost.cjs');
const { engineRoot } = require('./engine.cjs');

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
    const server = http.createServer((request, response) => {
      let url;
      try {
        url = new URL(request.url, 'http://127.0.0.1');
      } catch {
        response.writeHead(400).end();
        return;
      }

      const answer = handle({
        path: url.pathname,
        session: url.searchParams.get('session') ?? undefined,
      });

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

/**
 * Answers `ascdesktop://fonts/...` off disk.
 *
 * Registered once, at first use. `fontFileFromUrl` is what decides whether a
 * request names a font at all — without that check this handler would be a way
 * to read any file on the machine.
 */
function registerFontProtocol(electron) {
  let registered = false;
  return (fontFileFromUrl) => {
    if (registered) return;
    registered = true;
    electron.protocol.handle('ascdesktop', (request) => {
      const file = fontFileFromUrl(request.url);
      if (!file) return new Response('', { status: 403 });
      try {
        return new Response(fs.readFileSync(file), {
          headers: { 'Content-Type': contentType(file) },
        });
      } catch {
        return new Response('', { status: 404 });
      }
    });
  };
}

/**
 * Must run before the app is ready, so the scheme resolves relative urls and
 * is allowed past the page's content security policy.
 */
function registerEditorSchemes(electron) {
  electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: 'ascdesktop',
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true },
    },
  ]);
}

function createEditorRuntime({ electron, projectRoot } = {}) {
  return createEditorHost({
    editorsRoot: path.join(engineRoot({ projectRoot }), 'editors'),
    listen: listenLoopback,
    registerFontProtocol: electron ? registerFontProtocol(electron) : () => {},
  });
}

module.exports = { createEditorRuntime, listenLoopback, registerEditorSchemes, contentType };
