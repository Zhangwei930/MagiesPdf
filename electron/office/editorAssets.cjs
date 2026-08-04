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
 * How a document server stores the fonts it serves.
 *
 * The engine exclusive-ors the first 32 bytes of every font it downloads with
 * this key, expecting to undo an obfuscation applied when the fonts were
 * generated. Serving a plain font does not skip that step — it applies it, and
 * the engine ends up with 32 bytes of noise where the font's tables should be.
 */
const ODTTF_KEY = Buffer.from([
  0xa0, 0x66, 0xd6, 0x20, 0x14, 0x96, 0x47, 0xfa,
  0x95, 0x69, 0xb8, 0x50, 0xb0, 0x41, 0x49, 0x48,
]);

/** A font as the engine expects to receive it. Does not touch the original. */
function obfuscateFont(bytes) {
  const out = Buffer.from(bytes);
  const count = Math.min(32, out.length);
  for (let index = 0; index < count; index += 1) {
    out[index] ^= ODTTF_KEY[index % ODTTF_KEY.length];
  }
  return out;
}

/**
 * Configuration a document server would hold, which this host does not.
 *
 * The editor asks for a theme list and a plugin list every time a document
 * opens, and registers a service worker to cache itself offline. All three
 * belong to a server; none of them changes what the editor can do here. They
 * are answered rather than left to 404 so that a real failure is findable in
 * the console instead of buried among these.
 */
const SERVER_CONFIG = new Map([
  ['/editors/themes.json', { type: 'application/json; charset=utf-8', body: '{"themes":[]}' }],
  ['/editors/plugins.json', { type: 'application/json; charset=utf-8', body: '{"pluginsData":[]}' }],
  ['/editors/document_editor_service_worker.js', {
    type: 'text/javascript; charset=utf-8',
    // Registering is what the editor wants; there is nothing here to cache.
    body: '// Nothing to cache: every asset is served from this machine.\n',
  }],
]);

/** The answer for one of those routes, or null if this is not one. */
function emptyConfig(route) {
  return SERVER_CONFIG.get(route) ?? null;
}

/** Whether a route is asking for one of the engine's fonts. */
function isFontRoute(route) {
  return route.startsWith('/editors/fonts/');
}

/**
 * The engine's entry script, which ships as a template.
 *
 * A server would render a build hash into it; there is one version here and
 * nothing to bust a cache against, and the template skips that substitution
 * when it finds itself unrendered. So it is served as it is.
 */
const API_SCRIPT = '/web-apps/apps/api/documents/api.js';

/**
 * Maps a request to a file on disk, or to nothing.
 *
 * `activeSession` is needed because the editor asks for images by the key they
 * had in the document map — `/media/image1.png` — rather than by the url that
 * key pointed at.
 */
function resolveAsset(route, roots, activeSession = '') {
  if (route.startsWith('/editors/')) {
    const rest = route.slice('/editors'.length);
    return within(roots.editors, rest === API_SCRIPT ? `${API_SCRIPT}.tpl` : rest);
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
function editorPageSource({ documentType, title, fileType, sessionId }) {
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
      // The engine posts the document back on a route ending in this key, so
      // it has to be the session — it is all the host has to match an upload
      // against, and a key of its own makes every save a 404.
      key: sessionId,
      permissions: { edit: true, download: true, print: true },
    },
    editorConfig: {
      // What the file menu may ask this app to do. Each one hides its menu
      // entry unless the host says it can answer, and each is answered by an
      // event rather than by reaching into the engine's own menu.
      canRequestCreateNew: true,
      canRequestOpen: true,
      canRequestSaveAs: true,
      mode: 'edit',
      lang: 'zh',
      user: { id: 'local', name: 'Magies' },
      customization: { about: false, feedback: false, compactHeader: false },
    },
  });

  // A document called </script>… would otherwise close the script block and
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

  /**
   * The engine's own chrome, hidden in the frame it runs in.
   *
   * Its mark belongs to the software this app embeds rather than to this app,
   * and its licence asks for appropriate legal notices rather than for its
   * logo — those are in settings. The signed-in avatar is worse than
   * decoration: there is no account here, one machine and one file.
   *
   * Injected as a stylesheet rather than by editing the engine's own files,
   * which are redistributed byte for byte.
   */
  var CHROME_CSS = '#header-logo, #header-logo *, .btn-current-user { display: none !important; }';

  function hideEngineChrome() {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      try {
        var doc = frames[i].contentDocument;
        if (!doc || !doc.head || doc.getElementById('magies-chrome')) continue;
        var style = doc.createElement('style');
        style.id = 'magies-chrome';
        style.textContent = CHROME_CSS;
        doc.head.appendChild(style);
      } catch (error) { /* another origin: not the engine's */ }
    }
  }

  /**
   * Watched from the moment this page runs, not from when a document opens.
   *
   * The engine draws its header as its own page loads, long before it reports
   * a document ready — hiding the mark then means it has already been seen,
   * and every document opened flashes it. The watch also survives the frame
   * navigating, which replaces the document and the stylesheet with it.
   */
  /**
   * Draws the names in the font dropdown.
   *
   * Every row of that list is an image cut from a strip of pre-rendered font
   * names, and the strip is made by a tool that ships only for Linux. The one
   * generated here is blank — the right size, so the list builds and scrolls,
   * but every row comes out empty, which is a list of nothing.
   *
   * So each row is drawn here instead. The loader keeps getImage on the
   * instance rather than on a prototype, so that is what is replaced.
   */
  function drawFontNames(w) {
    if (!w.Common || !w.Common.UI || !w.Common.UI.ComboBoxFonts || w.__magiesNames) return;
    w.__magiesNames = true;

    var combo = w.Common.UI.ComboBoxFonts.prototype;
    var fill = combo.fillFonts;
    combo.fillFonts = function () {
      var loader = this.spriteThumbs;
      if (loader && !loader.__magiesNames) {
        loader.__magiesNames = true;
        loader.getImage = function (index) {
          var infos = w.AscFonts && w.AscFonts.g_font_infos;
          var name = infos && infos[index] ? infos[index].Name : '';
          var scale = w.devicePixelRatio || 1;
          var width = 300;
          var height = 28;

          var canvas = w.document.createElement('canvas');
          canvas.width = width * scale;
          canvas.height = height * scale;
          canvas.style.width = width + 'px';
          canvas.style.height = height + 'px';

          var ctx = canvas.getContext('2d');
          ctx.scale(scale, scale);
          ctx.fillStyle = w.getComputedStyle(w.document.body).color || '#000';
          ctx.font = '13px -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(name, 4, height / 2);
          return canvas;
        };
      }
      return fill.apply(this, arguments);
    };
  }

  setInterval(function () {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      try {
        if (frames[i].contentWindow) drawFontNames(frames[i].contentWindow);
      } catch (error) { /* another origin: not the engine's */ }
    }
  }, 150);

  setInterval(hideEngineChrome, 40);
  hideEngineChrome();

  config.events = {
    // The shell cannot see inside the engine, so the engine has to say when
    // the document is open and when it has unsaved changes.
    onDocumentReady: function () {
      hideEngineChrome();
      bindShortcut();
      parent.postMessage({ magies: 'ready' }, '*');
    },
    onDocumentStateChange: function (event) {
      parent.postMessage({ magies: 'modified', modified: !!(event && event.data) }, '*');
    },
    // Saving finishes by the engine offering the file it produced. The
    // document has already been written by the host at that point, so this
    // exists to take the offer and drop it — unhandled, it becomes a download.
    onDownloadAs: function () {},

    // Everything the file menu hands back to the host. The engine only asks;
    // what a new document, a picker or a target path mean is the shell's.
    onRequestCreateNew: function () {
      parent.postMessage({ magies: 'requestCreateNew' }, '*');
    },
    onRequestOpen: function () {
      parent.postMessage({ magies: 'requestOpen' }, '*');
    },
    onRequestSaveAs: function () {
      parent.postMessage({ magies: 'requestSaveAs' }, '*');
    },

    onError: function (event) {
      parent.postMessage({ magies: 'error', data: event && event.data }, '*');
    },
  };

  var editor = new DocsAPI.DocEditor('editor', config);

  /**
   * Saving.
   *
   * downloadAs is the engine's cloud path: it makes the engine POST its
   * current document back to the host in chunks, which is where the save
   * actually happens. This only starts it, and nothing comes back through here.
   *
   * The desktop path — window.AscDesktopEditor — is deliberately not taken.
   * These assets come from the desktop build, so sdkjs would use that host for
   * far more than saving, and every call it makes is one this page would have
   * to answer for.
   */
  /**
   * The format the engine already holds a document in.
   *
   * Asking for docx would make the engine build one in the browser; asking
   * for its own binary makes it hand over what it has, and the host converts
   * with the native converter it already ships — which takes a fifth of a
   * second on a document this size.
   */
  var ENGINE_FORMAT = { word: 0x1001, cell: 0x1002, slide: 0x1003 };

  /** The frame the engine runs in, which is not this page. */
  function engineWindow() {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      try {
        var w = frames[i].contentWindow;
        if (w && w.Asc && w.Asc.editor) return w;
      } catch (error) { /* another origin: not ours */ }
    }
    return null;
  }

  /**
   * Saving.
   *
   * Not the download the embedding interface offers: that blocks the editor
   * behind a progress dialog for the length of the operation, and finishes by
   * fetching the file it produced — which is a document already written to
   * disk, so fetching it is a download nobody asked for. Asking the engine
   * itself, with no action type and a callback, does neither.
   *
   * The document reaches the host as an upload while this runs; the callback
   * only says the engine has finished handing it over.
   */
  var saving = false;

  function save() {
    // The shortcut is bound in more than one window and the shell asks for a
    // save of its own, so one keystroke arrives here several times. Each is
    // the whole document serialised, uploaded and converted.
    if (saving) return;

    var w = engineWindow();
    if (!w) {
      parent.postMessage({ magies: 'saveFailed', reason: 'the engine is not ready' }, '*');
      return;
    }
    try {
      var format = ENGINE_FORMAT[${JSON.stringify(documentType)}] || ENGINE_FORMAT.word;
      var options = new w.Asc.asc_CDownloadOptions(format, false);
      options.callback = function () {
        saving = false;
        parent.postMessage({ magies: 'saved' }, '*');
      };
      saving = true;
      w.Asc.editor.downloadAs(null, options);
    } catch (error) {
      saving = false;
      parent.postMessage({ magies: 'saveFailed', reason: String(error) }, '*');
    }
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.magies === 'save') save();
  });

  function onKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && String(event.key).toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  }

  /**
   * ⌘S is pressed with focus inside the frame DocsAPI builds, so the keystroke
   * lands on a window both the shell and this page are outside of. Binding it
   * only here would mean the shortcut worked everywhere except in the document.
   */
  function bindShortcut() {
    window.addEventListener('keydown', onKeydown, true);
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      try {
        frames[i].contentWindow.addEventListener('keydown', onKeydown, true);
      } catch (error) { /* another origin: not the engine's */ }
    }
  }

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
  var READY_POLL_MS = 25;
  var READY_TIMEOUT_MS = 15000;
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

    // Every accepted batch of changes carries the next index; the engine uses
    // it to know its edits were taken and to release the save lock. Left
    // unanswered it decides no server is listening and falls back to asking a
    // desktop host to write the file — which is not there, so saving fails.
    var syncIndex = 0;

    this._server.on('message', function (payload) {
      var type = payload && payload.type;
      var reply = function (msg) { setTimeout(function () { self._client.emit('message', msg); }, 0); };
      if (type === 'isSaveLock') {
        reply({ type: 'saveLock', saveLock: false });
      } else if (type === 'saveChanges') {
        syncIndex += 1;
        reply({
          type: 'unSaveLock',
          index: typeof payload.startSaveChanges === 'number'
            ? payload.startSaveChanges
            : typeof payload.endSaveChanges === 'number' ? payload.endSaveChanges : -1,
          syncChangesIndex: syncIndex,
          time: Date.now()
        });
      } else if (type === 'getLock') {
        reply({ type: 'getLock', locks: [] });
      } else if (type === 'unSaveLock') {
        reply({ type: 'unSaveLock', index: -1, time: Date.now() });
      } else if (type === 'getMessages') {
        reply({ type: 'message', messages: [] });
      }
    });

    this.connect();
  }

  Socket.prototype._deliver = function (messages) {
    for (var i = 0; i < messages.length; i += 1) this._client.emit('message', messages[i]);
  };

  /**
   * Hands over the document once the engine can take it.
   *
   * The engine loads a very large script and only then builds the font
   * application it lays text out with. A document delivered before that is
   * shaped against fonts that do not exist yet, and the engine dies on a null
   * face — so this waits for the measurer rather than guessing a delay.
   *
   * It gives up eventually: an editor showing a document that cannot be laid
   * out is worse than one that says it could not open it.
   */
  Socket.prototype._deliverWhenReady = function () {
    var self = this;
    var waited = 0;
    var poll = setInterval(function () {
      var ready = window.AscCommon
        && window.AscCommon.g_oTextMeasurer
        && window.AscFonts
        && window.AscFonts.g_font_infos
        && window.AscFonts.g_font_infos.length > 0;

      waited += READY_POLL_MS;
      if (!ready && waited < READY_TIMEOUT_MS) return;

      clearInterval(poll);
      self._deliver(DOCUMENT_MESSAGES);
    }, READY_POLL_MS);
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
      self._deliverWhenReady();
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

module.exports = {
  documentUrls,
  editorPageSource,
  emptyConfig,
  isFontRoute,
  obfuscateFont,
  resolveAsset,
  socketStubSource,
};
