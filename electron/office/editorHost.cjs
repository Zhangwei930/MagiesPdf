const crypto = require('node:crypto');
const path = require('node:path');
const { connectMessages, documentMessages } = require('./editorHandshake.cjs');
const {
  documentUrls,
  editorPageSource,
  emptyConfig,
  isFontRoute,
  resolveAsset,
  socketStubSource,
} = require('./editorAssets.cjs');
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

/**
 * Where the engine posts a document back.
 *
 * It resolves this against the page it runs in, which is served from under the
 * editors — so what arrives is `/editors/downloadas/<session>` rather than the
 * bare path. Matching on the segment rather than the start of the route
 * accepts both, and the bare one is what the tests and any future caller use.
 */
const UPLOAD_ROUTE = '/downloadas/';

/** Session id from `/…/downloadas/<id>` or `/…/downloadas/<id>/saved`. */
function sessionIdFromUploadPath(route) {
  const at = String(route).indexOf(UPLOAD_ROUTE);
  if (at < 0) return '';
  return String(route).slice(at + UPLOAD_ROUTE.length).split('/')[0] || '';
}

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
   * Two different operations land here:
   * - A normal save: the bytes are the engine binary, and the shell writes
   *   them back through `onDocumentSaved`.
   * - "Save copy as" (`isSaveAs`): the engine has already converted to the
   *   format the user picked. Those bytes must not go through the session
   *   path — writing a PDF over a .docx as if it were Editor.bin is what made
   *   the menu item appear to do nothing. They are held as an export for the
   *   shell to write wherever the user chooses.
   */
  async function acceptUpload(request) {
    const session = sessions.get(sessionIdFromUploadPath(request.path));
    if (!session) return { status: 404 };

    const command = request.command ?? {};
    // GET (no body) serves the finished export so the engine can fetch the URL
    // we put in the upload reply. Empty POST bodies are real uploads with no
    // payload yet — they must not be mistaken for that fetch.
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (!session.export?.bytes) return { status: 404 };
      return {
        status: 200,
        type: 'application/octet-stream',
        body: session.export.bytes,
      };
    }

    const body = request.body ?? Buffer.alloc(0);
    const document = session.upload.accept(command, body);
    if (!document) {
      // Intermediate parts need `data` as a save key; without it multi-part
      // downloads stall. The key is opaque to the engine as long as it returns.
      return {
        status: 200,
        type: 'application/json',
        body: JSON.stringify({
          type: command.c ?? 'save',
          status: 'ok',
          data: session.id,
        }),
      };
    }

    if (command.isSaveAs) {
      session.export = {
        bytes: document,
        title: typeof command.title === 'string' && command.title ? command.title : session.title,
      };
    } else {
      session.export = null;
      await onDocumentSaved(session.id, document);
    }

    // The engine holds the editor behind a progress dialog until the reply
    // names the file the operation produced, and matches the reply to the
    // command it sent. The document is already written by now; this is what
    // lets the editor carry on.
    return {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        type: command.c ?? 'save',
        status: 'ok',
        data: `${UPLOAD_ROUTE}${session.id}/saved`,
        filetype: session.fileType,
      }),
    };
  }

  function handle(request) {
    const route = request.path;

    if (route.includes(UPLOAD_ROUTE)) return acceptUpload(request);

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
          sessionId: session.id,
          uiTheme: session.uiTheme,
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

    const config = emptyConfig(route);
    if (config) return { status: 200, type: config.type, body: config.body };

    const file = resolveAsset(route, roots(), request.session ?? activeSession);
    if (!file) return { status: 404 };
    // A font is not served as it sits on disk: the engine expects the
    // obfuscation a document server's fonts are stored under, and undoes it.
    return { status: 200, file, font: isFontRoute(route) };
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
      uiTheme = 'theme-white',
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
        uiTheme,
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

    /**
     * Takes the file "Save copy as" produced, once.
     *
     * The shell asks where it should go after the engine posts the export; this
     * hands over the bytes and clears them so a second call cannot write the
     * same copy twice by accident.
     */
    consumeExport(id) {
      const session = sessions.get(id);
      if (!session?.export?.bytes) throw new Error(`No export ready for Office session: ${id}`);
      const taken = session.export;
      session.export = null;
      return taken;
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
