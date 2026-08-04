const path = require('node:path');

/**
 * What the embedded editor is served, and from where.
 *
 * Three kinds of thing go over the wire: the vendored engine, the parts of the
 * open document, and one substitution — the editor's socket.io is replaced with
 * a stand-in, because the document arrives through that socket and there is no
 * server on the other end of a real one.
 */

/** The parts of a document, as the editor expects to be told about them. */
function documentUrls({ id, media }) {
  const urls = { 'Editor.bin': `/session/${id}/Editor.bin` };
  for (const name of media) urls[`media/${name}`] = `/session/${id}/media/${name}`;
  return urls;
}

/** Keeps a crafted path from reaching outside the directory it names. */
function within(root, relative) {
  const resolved = path.resolve(root, '.' + relative);
  return resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep)
    ? resolved
    : '';
}

/**
 * Maps a request to a file on disk, or to nothing.
 *
 * `activeSession` is needed because the editor asks for images by the key they
 * had in the document map — `/media/image1.png` — rather than by the url that
 * key pointed at.
 */
function resolveAsset(route, roots, activeSession = '') {
  if (route.startsWith('/editors/')) {
    return within(roots.editors, route.slice('/editors'.length));
  }
  if (route.startsWith('/session/')) {
    const rest = route.slice('/session/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return '';
    const workDir = roots.sessions[rest.slice(0, slash)];
    return workDir ? within(workDir, rest.slice(slash)) : '';
  }
  if (route.startsWith('/media/')) {
    const workDir = roots.sessions[activeSession];
    return workDir ? within(workDir, route) : '';
  }
  return '';
}

/**
 * The page the renderer's frame is pointed at.
 *
 * It does one thing: start the engine on the document this session holds. In
 * particular it does *not* define `window.AscDesktopEditor`. The engine takes
 * one of two paths to a document depending on whether a desktop host is
 * present, and only the other one ends anywhere here — with a bridge it waits
 * for a native host that does not exist, ignoring the socket the document
 * actually arrives through.
 */
function editorPageSource({ documentType, title, fileType }) {
  const config = JSON.stringify({
    width: '100%',
    height: '100%',
    documentType,
    document: {
      title,
      // The parts arrive through the socket; a url has to be here for the
      // config to be accepted at all.
      url: '/session/current/Editor.bin',
      fileType,
      key: `magies-${Date.now()}`,
      permissions: { edit: true, download: true, print: true },
    },
    editorConfig: {
      mode: 'edit',
      lang: 'zh',
      user: { id: 'local', name: 'Magies' },
      customization: { about: false, feedback: false, compactHeader: false },
    },
  });

  // A document called `</script>…` would otherwise close the script block and
  // run whatever followed it, so the JSON is escaped for its surroundings.
  const inlineConfig = config.replaceAll('<', '\\u003c');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#editor{height:100%}</style>
</head>
<body>
<div id="editor"></div>
<script src="/editors/web-apps/apps/api/documents/api.js"></script>
<script>
(function () {
  var config = ${inlineConfig};
  config.events = {
    // The shell cannot see inside the engine, so the engine has to say when
    // the document has unsaved changes.
    onDocumentStateChange: function (event) {
      parent.postMessage({ magies: 'modified', modified: !!(event && event.data) }, '*');
    },
    onError: function (event) {
      parent.postMessage({ magies: 'error', data: event && event.data }, '*');
    },
  };
  var editor = new DocsAPI.DocEditor('editor', config);

  // ⌘S is pressed in the shell, but the document is in here. Asking the engine
  // to produce it makes it POST itself back to the host, which is where the
  // save actually happens; this only starts it.
  function save() {
    try {
      editor.downloadAs('bin');
    } catch (error) {
      parent.postMessage({ magies: 'saveFailed', reason: String(error) }, '*');
    }
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.magies === 'save') save();
  });

  // ⌘S is pressed while the editor has focus, so the shell never sees it —
  // its keydown listener is on a window this one is nested inside. Catching it
  // here is what makes the shortcut work where the user actually presses it.
  window.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  }, true);
})();
</script>
</body>
</html>
`;
}

/** Keeps a document's name from ending the script or the title element. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The socket the editor talks to.
 *
 * It is a stand-in for socket.io shaped closely enough that the editor's
 * co-authoring client cannot tell: the client reaches into `socket.io` for
 * transport settings before it will register a message handler, so those
 * members have to exist even though they do nothing.
 *
 * It also speaks first. The client registers a handler and waits rather than
 * sending `auth`, so both halves of the conversation are pushed at it.
 */
function socketStubSource({ connect, document }) {
  return `(function (global) {
  var CONNECT_MESSAGES = ${JSON.stringify(connect)};
  var DOCUMENT_MESSAGES = ${JSON.stringify(document)};

  function Emitter() { this.map = Object.create(null); }
  Emitter.prototype.on = function (event, fn) { (this.map[event] = this.map[event] || []).push(fn); };
  Emitter.prototype.once = function (event, fn) {
    var self = this;
    var wrapped = function () { self.off(event, wrapped); fn.apply(null, arguments); };
    this.on(event, wrapped);
  };
  Emitter.prototype.off = function (event, fn) {
    if (!fn) { delete this.map[event]; return; }
    this.map[event] = (this.map[event] || []).filter(function (f) { return f !== fn; });
  };
  Emitter.prototype.removeAll = function (event) {
    if (event) delete this.map[event]; else this.map = Object.create(null);
  };
  Emitter.prototype.emit = function (event) {
    var args = Array.prototype.slice.call(arguments, 1);
    var list = (this.map[event] || []).slice();
    for (var i = 0; i < list.length; i += 1) {
      try { list[i].apply(null, args); } catch (error) { console.error('[office socket]', error); }
    }
  };

  function Socket() {
    this.active = true;
    this.connected = false;
    this.disconnected = true;
    this.recovered = false;
    this.id = '';
    this._client = new Emitter();
    this._server = new Emitter();
    var self = this;

    // Transport settings the client reads before it will go any further. A
    // missing member throws inside its setup, and the failure is silent.
    var chain = function () { return self.io; };
    this.io = {
      setOpenToken: function () {}, setSessionToken: function () {},
      on: chain, reconnectionAttempts: chain, reconnectionDelay: chain,
      reconnectionDelayMax: chain, timeout: chain, transports: chain,
      upgrade: chain, upgradeTransport: chain, upgradeTimeout: chain
    };

    this.server = {
      on: function (event, fn) { self._server.on(event, fn); },
      off: function (event, fn) { self._server.off(event, fn); },
      emit: function () { self._client.emit.apply(self._client, arguments); }
    };

    this._server.on('message', function (payload) {
      var type = payload && payload.type;
      var reply = function (msg) { setTimeout(function () { self._client.emit('message', msg); }, 0); };
      if (type === 'isSaveLock') reply({ type: 'saveLock', saveLock: false });
      else if (type === 'getLock') reply({ type: 'getLock', locks: [] });
      else if (type === 'unSaveLock') reply({ type: 'unSaveLock', index: -1, time: Date.now() });
      else if (type === 'getMessages') reply({ type: 'message', messages: [] });
    });

    this.connect();
  }

  Socket.prototype._deliver = function (messages) {
    for (var i = 0; i < messages.length; i += 1) this._client.emit('message', messages[i]);
  };
  Socket.prototype.on = function (event, fn) { this._client.on(event, fn); return this; };
  Socket.prototype.once = function (event, fn) { this._client.once(event, fn); return this; };
  Socket.prototype.off = function (event, fn) { this._client.off(event, fn); return this; };
  Socket.prototype.removeAllListeners = function (event) { this._client.removeAll(event); return this; };
  Socket.prototype.compress = function () { return this; };
  Socket.prototype.open = function () { return this.connect(); };
  Socket.prototype.connect = function () {
    if (this.connected) return this;
    this.connected = true;
    this.disconnected = false;
    this.id = Math.random().toString(36).slice(2, 15);
    var self = this;
    setTimeout(function () {
      self._client.emit('connect');
      // The client will not ask, so it is told: first what a server announces
      // on connect, then the document itself.
      setTimeout(function () { self._deliver(CONNECT_MESSAGES); }, 20);
      setTimeout(function () { self._deliver(DOCUMENT_MESSAGES); }, 120);
    }, 0);
    return this;
  };
  Socket.prototype.disconnect = function () {
    this.connected = false; this.disconnected = true; this._client.emit('disconnect'); return this;
  };
  Socket.prototype.close = function () { return this.disconnect(); };
  Socket.prototype.send = function () {
    return this.emit.apply(this, ['message'].concat(Array.prototype.slice.call(arguments)));
  };
  Socket.prototype.emit = function (event) {
    if (!this.connected) return this;
    var args = Array.prototype.slice.call(arguments, 1);
    var self = this;
    setTimeout(function () { self._server.emit.apply(self._server, [event].concat(args)); }, 0);
    return this;
  };

  function io() { return new Socket(); }
  io.Socket = Socket;
  io.connect = io;
  io.Manager = function () { return { socket: io }; };
  global.io = io;
  if (typeof define === 'function' && define.amd) define([], function () { return io; });
  else if (typeof module === 'object' && module.exports) module.exports = io;
})(typeof window !== 'undefined' ? window : this);
`;
}

module.exports = { documentUrls, editorPageSource, resolveAsset, socketStubSource };
