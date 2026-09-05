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
/**
 * ONLYOFFICE uiTheme ids the engine understands.
 * Prefer white: dark skins left black text on a dark canvas in this embed.
 */
function officeUiTheme(value) {
  if (value === 'theme-dark' || value === 'theme-night' || value === 'theme-contrast-dark') return value;
  if (value === 'theme-light' || value === 'theme-white' || value === 'theme-classic-light' || value === 'theme-gray') {
    return value;
  }
  // Default white, not system — system-dark painted black text on black UI.
  return 'theme-white';
}

function editorPageSource({ documentType, title, fileType, sessionId, uiTheme = 'theme-white' }) {
  /**
   * The placeholder's id names the session on purpose.
   *
   * ONLYOFFICE carries it into the url of the frame it builds for the engine,
   * as `frameEditorId`. That frame's url is the referer on every request the
   * engine then makes, and it is otherwise the same for every open document —
   * so without this the host had nothing to go on and fell back to whichever
   * session was last focused. See `sessionFromReferer`.
   */
  const frameEditorId = `editor-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const theme = officeUiTheme(uiTheme);
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
      // Without uiTheme the engine often keeps a dark loadmask / chrome that
      // does not track the OS, so the document looks covered by a black pane.
      customization: {
        about: false,
        feedback: false,
        compactHeader: false,
        uiTheme: theme,
      },
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
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#fff;color:#222}
.magies-editor{height:100%;background:#fff}
/* Keep loadmask / file panels from sitting as a black veil on the page. */
.loadmask,.asc-loadmask,.modals-mask,#loading-mask{background:rgba(255,255,255,.72)!important}
</style>
</head>
<body>
<div id="${frameEditorId}" class="magies-editor"></div>
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
  // White chrome: dark theme left black text on black toolbars in this embed.
  // File menu is a compact top-left list over the live document (WPS-like),
  // not a full-screen panel with 返回 + 下载为/信息 on the right.
  var CHROME_CSS = [
    '#header-logo, #header-logo *, .btn-current-user, #slot-btn-share, .btn-header-share { display: none !important; }',
    'html, body, #viewport, .layout-region, .toolbar, .toolbar-full, #toolbar,',
    '.panel-left, .left-panel, #left-menu, .file-menu,',
    '.asc-window, .modals-mask, .loadmask, #loading-mask { background-color: #fff !important; color: #222 !important; }',
    '.toolbar, .toolbar * { color: #222 !important; }',
    /* Drop portal / unused file-menu rows */
    '#fm-btn-return, #fm-btn-download, #fm-btn-rename, #fm-btn-protect, #fm-btn-info,',
    '#fm-btn-history, #fm-btn-rights, #fm-btn-help, #fm-btn-suggest,',
    '#fm-btn-settings, #fm-btn-back, #fm-btn-recent, #fm-btn-edit,',
    '#fm-btn-switchmobile, #fm-btn-exit, #fm-btn-close { display: none !important; }',
    '#file-menu-panel .panel-menu .devider,',
    '#file-menu-panel .panel-menu .devider-small,',
    '#file-menu-panel .panel-menu .devider-last { display: none !important; }',
    /* No right-hand "下载为 / 信息" column — document stays visible underneath */
    '#file-menu-panel .panel-context { display: none !important; }',
    /* Floating top-left menu: only as wide as the list so the document shows. */
    '#file-menu-panel.toolbar-fullview-panel {',
    '  top: 0 !important; left: 0 !important; right: auto !important; bottom: auto !important;',
    '  width: 240px !important; height: auto !important; max-height: none !important;',
    '  background: transparent !important; border: 0 !important;',
    '  overflow: visible !important; z-index: 1005 !important;',
    '  pointer-events: auto !important;',
    '}',
    '#file-menu-panel.toolbar-fullview-panel > div {',
    '  height: auto !important; width: auto !important;',
    '}',
    '#file-menu-panel .panel-menu {',
    '  float: none !important; display: flex !important; flex-direction: column;',
    '  width: 220px !important; max-height: min(70vh, 520px); overflow-x: hidden !important; overflow-y: auto !important;',
    '  margin: 48px 0 12px 8px; padding: 6px 0 8px !important;',
    '  border: 1px solid rgba(0,0,0,.1) !important; border-radius: 8px;',
    '  background: #fff !important; box-shadow: 0 8px 28px rgba(0,0,0,.16);',
    '  pointer-events: auto !important;',
    '}',
    '#file-menu-panel .panel-menu .fm-btn { pointer-events: auto !important; cursor: pointer !important; }',
    '#fm-btn-create { order: 1; }',
    '#fm-btn-local-open { order: 2; }',
    '#fm-btn-save { order: 3; }',
    '#fm-btn-save-copy, #fm-btn-save-desktop { order: 4; }',
    '#fm-btn-export-pdf { order: 5; }',
    '#fm-btn-print, #fm-btn-print-with-preview { order: 6; }',
  ].join('\\n');

  function hideEngineChrome() {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      try {
        var doc = frames[i].contentDocument;
        if (!doc || !doc.head) continue;
        var style = doc.getElementById('magies-chrome');
        if (!style) {
          style = doc.createElement('style');
          style.id = 'magies-chrome';
          doc.head.appendChild(style);
        }
        // Always refresh: layout fixes must land without reopening the document.
        if (style.textContent !== CHROME_CSS) style.textContent = CHROME_CSS;
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
   * generated here is blank: the right size, so the list builds and scrolls,
   * but every row is empty.
   *
   * So each row is drawn on demand instead. Two things about where this goes,
   * each of which has already been got wrong once: the loader is created *by*
   * the call being wrapped, so it can only be replaced after that call; and it
   * keeps getImage on the instance, so replacing it on a prototype replaces a
   * method nothing calls.
   *
   * What this shows is the name, in the interface's own type — not a sample of
   * the typeface, which is what the real strip would have given.
   */
  function drawFontNames(w) {
    if (w.__magiesNames || !w.Common || !w.Common.UI || !w.Common.UI.ComboBoxFonts) return;
    w.__magiesNames = true;

    var combo = w.Common.UI.ComboBoxFonts.prototype;
    var fillFonts = combo.fillFonts;

    combo.fillFonts = function () {
      var result = fillFonts.apply(this, arguments);
      var loader = this.spriteThumbs;

      if (loader && !loader.magiesNames) {
        loader.magiesNames = true;
        loader.getImage = function (index) {
          var infos = (w.AscFonts && w.AscFonts.g_font_infos) || [];
          var name = infos[index] ? infos[index].Name : '';

          // The list sizes its rows in css pixels and expects the canvas to
          // carry the screen's own resolution behind them.
          var cssWidth = 300;
          var cssHeight = (w.Asc && w.Asc.FONT_THUMBNAIL_HEIGHT) || 28;
          var scale = w.devicePixelRatio || 1;

          var canvas = w.document.createElement('canvas');
          canvas.width = cssWidth * scale;
          canvas.height = cssHeight * scale;
          canvas.style.width = cssWidth + 'px';
          canvas.style.height = cssHeight + 'px';

          var ctx = canvas.getContext('2d');
          ctx.scale(scale, scale);
          ctx.fillStyle = w.getComputedStyle(w.document.body).color || '#000';
          ctx.font = '13px -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(name, 4, cssHeight / 2);
          return canvas;
        };
      }
      return result;
    };
  }

  setInterval(function () {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      try {
        if (frames[i].contentWindow) drawFontNames(frames[i].contentWindow);
      } catch (error) { /* another origin: not the engine's */ }
    }
  }, 100);

  setInterval(hideEngineChrome, 40);
  hideEngineChrome();

  config.events = {
    // The shell cannot see inside the engine, so the engine has to say when
    // the document is open and when it has unsaved changes.
    onDocumentReady: function () {
      hideEngineChrome();
      patchEngine();
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
    // Fires after the engine has already produced the copy (with a format
    // the user picked). The shell must write those bytes, not ask for another
    // engine save — that path expects the editor binary and made the menu
    // appear to do nothing.
    onRequestSaveAs: function (event) {
      var data = (event && event.data) || {};
      parent.postMessage({
        magies: 'exportReady',
        title: data.title || '',
        fileType: data.fileType || '',
      }, '*');
    },

    onError: function (event) {
      parent.postMessage({ magies: 'error', data: event && event.data }, '*');
    },
  };

  var editor = new DocsAPI.DocEditor(${JSON.stringify(frameEditorId)}, config);

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

  /**
   * "Save copy as" / download hangs on "电子表格下载中" without this.
   *
   * The engine's saveWithParts only invokes options.callback on success, not
   * the default fCurCallback that ends the progress dialog and fires
   * asc_onDownloadUrl. File-menu downloads never pass a callback, so the mask
   * stays up forever. Providing one restores the Document Server behaviour.
   */
  function patchDownloadAs(w) {
    if (!w || !w.Asc || !w.Asc.editor || w.Asc.editor.__magiesDownloadAs) return;
    var api = w.Asc.editor;
    if (typeof api.downloadAs !== 'function') return;
    api.__magiesDownloadAs = true;
    var original = api.downloadAs.bind(api);
    api.downloadAs = function (actionType, options) {
      options = options || new w.Asc.asc_CDownloadOptions();
      // PDF from the engine embeds Japanese faces for Chinese text. Ask for
      // the editor binary instead; the host re-renders with LibreOffice and
      // keeps the .pdf title so "Save copy as" still lands as a PDF.
      try {
        var fileTypes = w.Asc && w.Asc.c_oAscFileType;
        var pdf = fileTypes ? fileTypes.PDF : 0x0201;
        var pdfa = fileTypes ? fileTypes.PDFA : 0x0209;
        if (options.fileType === pdf || options.fileType === pdfa) {
          var engineFormat = ENGINE_FORMAT[${JSON.stringify(documentType)}] || ENGINE_FORMAT.word;
          if (typeof options.asc_setFileType === 'function') options.asc_setFileType(engineFormat);
          else options.fileType = engineFormat;
        }
      } catch (error) { /* keep the original request if the enum is missing */ }
      if (!options.callback) {
        var downloadType = w.AscCommon && w.AscCommon.DownloadType
          ? (options.isDownloadEvent
            ? (actionType === w.Asc.c_oAscAsyncAction.Print
              ? w.AscCommon.DownloadType.Print
              : w.AscCommon.DownloadType.Download)
            : w.AscCommon.DownloadType.None)
          : 'asc_onDownloadUrl';
        options.callback = function (input) {
          try {
            if (input && input.status === 'ok' && input.data) {
              api.processSavedFile(input.data, downloadType, input.filetype);
            } else if (actionType) {
              api.sendEvent(
                'asc_onError',
                w.Asc.c_oAscError.ID.Unknown,
                w.Asc.c_oAscError.Level.NoCritical,
              );
            }
          } catch (error) {
            console.error('[magies downloadAs]', error);
          }
          if (actionType) {
            try {
              api.sync_EndAction(w.Asc.c_oAscAsyncActionType.BlockInteraction, actionType);
            } catch (error) { /* dialog may already be gone */ }
          }
        };
      }
      return original(actionType, options);
    };
  }

  /** Replace a caption string inside a menu row without dropping its icon. */
  function replaceMenuText(root, from, to) {
    if (!root) return;
    var walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.indexOf(from) >= 0) {
        node.nodeValue = node.nodeValue.split(from).join(to);
      }
    }
  }

  function closeFileMenu(doc) {
    try {
      var ret = doc.getElementById('fm-btn-return');
      if (ret) ret.click();
    } catch (error) { /* menu may already be gone */ }
  }

  /**
   * WPS-style file menu actions.
   *
   * 另存为 → one OS path dialog (format from the extension filter).
   * 输出为PDF → same path, defaulting to .pdf and LibreOffice rendering.
   * No share, no engine format gallery.
   */
  function patchFileMenu(w) {
    var doc = w && w.document;
    if (!doc) return;

    var saveCopy = doc.getElementById('fm-btn-save-copy');
    if (saveCopy) {
      replaceMenuText(saveCopy, '另存副本为', '另存为');
      replaceMenuText(saveCopy, 'Save Copy as', 'Save As');
    }

    // Inject “输出为PDF” once the Save As row exists.
    if (saveCopy && !doc.getElementById('fm-btn-export-pdf')) {
      var pdfRow = saveCopy.cloneNode(true);
      pdfRow.id = 'fm-btn-export-pdf';
      pdfRow.classList.remove('active');
      replaceMenuText(pdfRow, '另存为', '输出为PDF');
      replaceMenuText(pdfRow, 'Save As', 'Export as PDF');
      replaceMenuText(pdfRow, '另存副本为', '输出为PDF');
      replaceMenuText(pdfRow, 'Save Copy as', 'Export as PDF');
      saveCopy.parentNode.insertBefore(pdfRow, saveCopy.nextSibling);
    }

    if (doc.__magiesSaveAsMenu) return;
    doc.__magiesSaveAsMenu = true;
    doc.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      var exportPdf = target.closest('#fm-btn-export-pdf');
      if (exportPdf) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        parent.postMessage({ magies: 'requestExportPdf' }, '*');
        closeFileMenu(doc);
        return;
      }

      var saveAs = target.closest('#fm-btn-save-copy, #fm-btn-save-desktop');
      if (!saveAs) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      parent.postMessage({ magies: 'requestSaveAs' }, '*');
      closeFileMenu(doc);
    }, true);
  }

  function patchEngine() {
    bindShortcut();
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i += 1) {
      try {
        if (frames[i].contentWindow) {
          patchDownloadAs(frames[i].contentWindow);
          patchFileMenu(frames[i].contentWindow);
        }
      } catch (error) { /* another origin */ }
    }
  }

  // DocsAPI builds the engine frame after DocEditor returns; keep trying until
  // downloadAs is on the window we can reach.
  setInterval(patchEngine, 250);
  patchEngine();

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
  officeUiTheme,
  resolveAsset,
  socketStubSource,
};
