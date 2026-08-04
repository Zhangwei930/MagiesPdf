const crypto = require('node:crypto');
const path = require('node:path');
const { connectMessages, documentMessages } = require('./editorHandshake.cjs');
const { documentUrls, editorPageSource, resolveAsset, socketStubSource } = require('./editorAssets.cjs');
const { createUploadBuffer } = require('./editorUpload.cjs');

/**
 * Serves the embedded editor to the renderer.
 *
 * The editor is a web app: it fetches its own engine, and it fetches the
 * document over the same origin. That needs a server, so this owns one — bound
 * to loopback, started when the first document opens and closed when the last
 * one goes, so an app that never opens an Office file never listens on
 * anything.
 *
 * Fonts come through it like everything else: the manifest names fonts that
 * ship with the engine, so the engine's font base resolves to a route under
 * the editors, with the same traversal guard on it as any other asset.
 */

function createEditorHost(deps) {
  const { editorsRoot, listen, onDocumentSaved = async () => {} } = deps;
  const sessions = new Map();
  let server = null;
  let starting = null;

  const roots = () => ({
    editors: editorsRoot,
    sessions: Object.fromEntries([...sessions].map(([id, s]) => [id, s.workDir])),
  });

  /**
   * Which document a media request belongs to.
   *
   * The editor asks for images by their map key — `/media/image1.png` — with
   * nothing to say which document they came from. With one editor visible at a
   * time the most recently published document is the right answer.
   */
  let activeSession = '';

  /**
   * A document the engine is sending back.
   *
   * The chunks arrive as ordinary POSTs; the buffer knows when they add up to
   * a whole document, and only then is anything written.
   */
  async function acceptUpload(request) {
    const session = sessions.get(request.path.slice('/downloadas/'.length));
    if (!session) return { status: 404 };

    const document = session.upload.accept(request.command ?? {}, request.body ?? Buffer.alloc(0));
    if (!document) return { status: 200, type: 'application/json', body: '{"status":"ok"}' };

    await onDocumentSaved(session.id, document);
    return { status: 200, type: 'application/json', body: '{"status":"ok"}' };
  }

  function handle(request) {
    const route = request.path;

    if (route.startsWith('/downloadas/')) return acceptUpload(request);

    // The entry point the renderer's frame is pointed at.
    if (route.startsWith('/editor/')) {
      const session = sessions.get(route.slice('/editor/'.length));
      if (!session) return { status: 404 };
      activeSession = session.id;
      return {
        status: 200,
        type: 'text/html; charset=utf-8',
        body: editorPageSource({
          documentType: session.documentType,
          title: session.title,
          fileType: session.fileType,
        }),
      };
    }

    if (route.endsWith('/vendor/socketio/socket.io.min.js')) {
      const session = sessions.get(request.session ?? activeSession);
      if (!session) return { status: 404 };
      return {
        status: 200,
        type: 'text/javascript; charset=utf-8',
        body: socketStubSource({
          connect: connectMessages({ sessionId: session.id }),
          document: documentMessages({
            sessionId: session.id,
            urls: session.urls,
            user: session.user,
            readOnly: session.readOnly,
          }),
        }),
      };
    }

    const file = resolveAsset(route, roots(), request.session ?? activeSession);
    return file ? { status: 200, file } : { status: 404 };
  }

  async function ensureServer() {
    if (server) return server;
    if (!starting) {
      starting = listen(handle).then((started) => {
        server = started;
        return started;
      });
    }
    return starting;
  }

  return {
    /** Makes a converted document reachable, and returns where to point at it. */
    async publish({
      id, workDir, media, title = '', documentType = 'word', fileType = 'docx',
      user = { id: 'local', name: 'Magies' }, readOnly = false,
    }) {
      const started = await ensureServer();
      sessions.set(id, {
        id,
        workDir,
        user,
        readOnly,
        title,
        documentType,
        fileType,
        urls: documentUrls({ id, media }),
        upload: createUploadBuffer(),
        frameId: crypto.randomUUID(),
      });
      activeSession = id;
      return {
        url: `http://127.0.0.1:${started.port}/editor/${id}`,
        editorsPath: path.join(editorsRoot, 'web-apps', 'apps'),
      };
    },

    focus(id) {
      if (sessions.has(id)) activeSession = id;
    },

    withdraw(id) {
      sessions.delete(id);
      if (activeSession === id) activeSession = [...sessions.keys()].at(-1) ?? '';
    },

    sessions() {
      return [...sessions.keys()];
    },

    async close() {
      sessions.clear();
      activeSession = '';
      const running = server;
      server = null;
      starting = null;
      if (running) await running.close();
    },
  };
}

module.exports = { createEditorHost };
