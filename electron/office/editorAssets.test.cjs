const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  documentUrls,
  editorPageSource,
  emptyConfig,
  obfuscateFont,
  resolveAsset,
  socketStubSource,
} = require('./editorAssets.cjs');

describe('the document parts handed to the editor', () => {
  it('names the editor binary and every extracted image', () => {
    const urls = documentUrls({ id: 'abc', media: ['image1.png', 'image2.jpeg'] });
    assert.equal(urls['Editor.bin'], '/session/abc/Editor.bin');
    assert.equal(urls['media/image1.png'], '/session/abc/media/image1.png');
    assert.equal(urls['media/image2.jpeg'], '/session/abc/media/image2.jpeg');
  });

  it('copes with a document that has no images', () => {
    assert.deepEqual(documentUrls({ id: 'abc', media: [] }), {
      'Editor.bin': '/session/abc/Editor.bin',
    });
  });
});

describe('resolving a request to a file', () => {
  const roots = { editors: '/engine/editors', sessions: { abc: '/tmp/work/abc' } };

  it('serves the engine from the vendored editors directory', () => {
    assert.equal(
      resolveAsset('/editors/sdkjs/word/sdk-all-min.js', roots),
      path.join('/engine/editors', 'sdkjs/word/sdk-all-min.js'),
    );
  });

  it('serves a session file from that session work directory', () => {
    assert.equal(resolveAsset('/session/abc/Editor.bin', roots), path.join('/tmp/work/abc', 'Editor.bin'));
  });

  /**
   * The editor resolves images against the document's own base, so it asks for
   * the map key rather than the url the key pointed at.
   */
  it('serves media asked for by its map key', () => {
    assert.equal(resolveAsset('/media/image1.png', roots, 'abc'), path.join('/tmp/work/abc', 'media/image1.png'));
  });

  it('refuses to climb out of a root', () => {
    assert.equal(resolveAsset('/editors/../../etc/passwd', roots), '');
    assert.equal(resolveAsset('/session/abc/../../../etc/passwd', roots), '');
  });

  it('refuses a session it does not know', () => {
    assert.equal(resolveAsset('/session/nope/Editor.bin', roots), '');
  });

  it('has nothing to say about an unknown route', () => {
    assert.equal(resolveAsset('/somewhere/else', roots), '');
  });
});

/**
 * The engine fetches fonts over http, concatenating its font base onto each
 * entry of the manifest. Those entries are filenames of fonts that ship with
 * the engine, so a font request is a request for a file under the editors like
 * any other — which is what keeps the traversal guard on it.
 */
/**
 * The engine expects its fonts obfuscated.
 *
 * After downloading one it exclusive-ors the first 32 bytes with a fixed key —
 * the scheme a document server's fonts are stored under. Serving a plain font
 * file therefore does not skip a decode step, it *applies* one: the engine
 * turns a valid font into 32 bytes of noise, FreeType refuses to open it, and
 * the failure surfaces much later as a null face while text is laid out.
 */
describe('serving a font', () => {
  const font = Buffer.concat([
    Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x12, 0x01, 0x00]),
    Buffer.alloc(40, 0xcd),
  ]);

  it('is undone exactly by what the engine does to it', () => {
    const served = obfuscateFont(font);
    const guid = [0xa0, 0x66, 0xd6, 0x20, 0x14, 0x96, 0x47, 0xfa,
      0x95, 0x69, 0xb8, 0x50, 0xb0, 0x41, 0x49, 0x48];

    const decoded = Buffer.from(served);
    for (let index = 0; index < Math.min(32, decoded.length); index += 1) {
      decoded[index] ^= guid[index % 16];
    }
    assert.deepEqual(decoded, font, 'the engine must get back the font it was given');
  });

  it('leaves everything past the first 32 bytes alone', () => {
    const served = obfuscateFont(font);
    assert.deepEqual(served.subarray(32), font.subarray(32));
  });

  it('does not read past a font shorter than the key', () => {
    const short = Buffer.from([0x00, 0x01, 0x00, 0x00]);
    assert.equal(obfuscateFont(short).length, 4);
  });

  it('does not modify the buffer it was given', () => {
    const original = Buffer.from(font);
    obfuscateFont(font);
    assert.deepEqual(font, original);
  });
});

describe('a font request', () => {
  const roots = { editors: '/engine/editors', sessions: {} };

  it('resolves to the font that ships with the engine', () => {
    assert.equal(
      resolveAsset('/editors/fonts/LiberationSerif-Regular.ttf', roots),
      '/engine/editors/fonts/LiberationSerif-Regular.ttf',
    );
  });

  /** The manifest is generated, but the route is still reachable by hand. */
  it('does not reach outside the engine', () => {
    assert.equal(resolveAsset('/editors/fonts/../../../etc/passwd', roots), '');
  });
});

/**
 * The engine's entry script ships as a template, because a server normally
 * renders a build hash into it. There is one version here and nothing to bust
 * a cache against, and the template skips that substitution when it is left
 * alone — so it is served as it is, under the name the page asks for.
 */
/**
 * Configuration a document server would serve, which this host does not have.
 *
 * The editor asks for a theme list and a plugin list on every open, and
 * registers a service worker for offline use. All three are a server's
 * business; none of them changes what the editor can do here. Answering with
 * nothing rather than letting them 404 keeps the console readable, which
 * matters — a real failure has to be findable among these.
 */
describe('the configuration a server would hold', () => {
  const roots = { editors: '/engine/editors', sessions: {} };

  it('answers the lists the editor asks for on every open', () => {
    for (const route of ['/editors/themes.json', '/editors/plugins.json']) {
      const answer = emptyConfig(route);
      assert.ok(answer, `${route} is left to 404`);
      assert.doesNotThrow(() => JSON.parse(answer.body), 'the editor parses these');
    }
  });

  /** Offline caching is a server's concern; there is nothing to cache here. */
  it('answers the service worker with something a browser accepts', () => {
    const answer = emptyConfig('/editors/document_editor_service_worker.js');
    assert.ok(answer);
    assert.match(answer.type, /javascript/);
  });

  it('leaves everything else to be served from disk', () => {
    assert.equal(emptyConfig('/editors/sdkjs/word/sdk-all.js'), null);
    assert.equal(resolveAsset('/editors/sdkjs/word/sdk-all.js', roots), '/engine/editors/sdkjs/word/sdk-all.js');
  });
});

describe('the editor api script', () => {
  const roots = { editors: '/engine/editors', sessions: {} };

  it('is answered from the template that ships in its place', () => {
    assert.equal(
      resolveAsset('/editors/web-apps/apps/api/documents/api.js', roots),
      '/engine/editors/web-apps/apps/api/documents/api.js.tpl',
    );
  });

  it('leaves every other script alone', () => {
    assert.equal(
      resolveAsset('/editors/web-apps/apps/documenteditor/main/app.js', roots),
      '/engine/editors/web-apps/apps/documenteditor/main/app.js',
    );
  });
});

describe('the page the frame is pointed at', () => {
  const page = editorPageSource({
    documentType: 'word', title: '报告.docx', fileType: 'docx', sessionId: 'sess-1',
  });

  /**
   * The engine posts the document back on a route ending in the document's
   * key, which is the only thing identifying it there — so the key has to be
   * the session, or the host has nothing to match the upload against and the
   * save comes back 404.
   */
  it('keys the document by the session it belongs to', () => {
    assert.match(page, /"key":"sess-1"/);
    assert.doesNotMatch(page, /magies-\$\{/, 'a key of its own cannot be matched to a session');
  });

  it('loads the engine and starts an editor', () => {
    assert.match(page, /api\/documents\/api\.js/);
    assert.match(page, /DocsAPI\.DocEditor/);
  });

  it('opens the document it was asked for', () => {
    assert.match(page, /"documentType":"word"|documentType: 'word'/);
    assert.match(page, /报告\.docx/);
  });

  /**
   * These assets come from the desktop build, whose sdkjs treats
   * `AscDesktopEditor` as a whole native host: it asks it about saving, but
   * also about the scroll wheel and the window. Defining a stand-in for it
   * puts the engine on that path with nothing behind it, and it fails on the
   * first call this page did not anticipate. Leaving it undefined is what
   * keeps the engine on the cloud path, where saving is a documented call.
   */
  it('never claims to be a desktop host', () => {
    assert.doesNotMatch(page, /AscDesktopEditor\s*=/, 'defining the desktop host strands the engine');
  });

  /** Two editors on one element race for the document; only one may exist. */
  it('builds exactly one editor', () => {
    assert.equal(page.split('new DocsAPI.DocEditor').length - 1, 1);
  });

  /** Saving is the public cloud call: it makes the engine POST the document. */
  it('saves through the editor api', () => {
    assert.match(page, /\.downloadAs\(/);
  });

  /**
   * ⌘S is pressed with focus inside the engine's own frame, so neither the
   * shell nor this page ever sees the event. The listener has to go on the
   * window the keystroke actually lands in.
   */
  it('catches the shortcut inside the engine frame', () => {
    assert.match(page, /addEventListener\('keydown'/);
    assert.match(page, /contentWindow/, 'the shortcut is only bound to this page');
  });

  /**
   * Saving goes through the engine's own api rather than the download the
   * embedding interface offers.
   *
   * That download blocks the editor behind a progress dialog for the length
   * of the operation and ends by fetching the file it produced — which here
   * is a document already written to disk, so fetching it is a download the
   * user did not ask for, on top of an editor they cannot use meanwhile.
   * Asking the engine directly, with no action type and a callback, does
   * neither.
   */
  it('saves without the download the embedding interface would run', () => {
    assert.match(page, /downloadAs\(null,/, 'an action type puts up the progress dialog');
    assert.match(page, /callback/, 'nothing tells the shell the save finished');
    assert.doesNotMatch(page, /downloadAs\('/, 'the embedding interface takes a format and runs the download');
  });

  /**
   * One save at a time.
   *
   * The shortcut is bound in more than one place and the shell asks for a
   * save of its own, so a single keystroke reaches this more than once. Each
   * one is the whole document serialised, uploaded and converted, so without
   * a guard a keypress costs several of them and the editor crawls.
   */
  it('ignores a save while one is already running', () => {
    assert.match(page, /saving/, 'nothing tracks a save in flight');
    assert.match(page, /if \(saving\) return;/);
  });

  /** The engine's own format: converting to docx is the host's job, and fast. */
  it('asks for the format the engine already holds', () => {
    assert.match(page, /0x1001/, 'word documents come back as the editor binary');
    assert.match(page, /0x1002/);
    assert.match(page, /0x1003/);
  });

  it('reports back when the engine says the document changed', () => {
    assert.match(page, /postMessage/);
    assert.match(page, /modified/);
  });

  it('escapes a title that would otherwise break out of the script', () => {
    const nasty = editorPageSource({
      documentType: 'word',
      title: '</script><script>alert(1)</script>',
      fileType: 'docx',
    });
    assert.doesNotMatch(nasty, /<script>alert\(1\)<\/script>/);
  });
});

describe('the socket stand-in served in place of socket.io', () => {
  const source = socketStubSource({
    connect: [{ sid: 's1' }],
    document: [{ type: 'authChanges' }],
  });

  it('carries the messages it must deliver', () => {
    assert.match(source, /"sid":"s1"/);
    assert.match(source, /"type":"authChanges"/);
  });

  /**
   * The document is delivered when the engine can take it, not at a guessed
   * moment. The engine loads a very large script and only then builds the
   * font application; a document that arrives before that is laid out against
   * fonts that do not exist yet, and shaping dies on a null face.
   */
  it('waits for the engine before handing it the document', () => {
    assert.match(source, /g_oTextMeasurer/, 'nothing is checked before delivering');
    assert.doesNotMatch(
      source,
      /_deliver\(DOCUMENT_MESSAGES\)[^;]*\}\s*,\s*\d+\s*\)/,
      'the document is still delivered on a timer',
    );
  });

  /** A wait with no end would leave the editor blank with nothing to show. */
  it('gives up waiting rather than hanging', () => {
    assert.match(source, /clearInterval/);
  });

  /** Missing any of these and the editor stops before it registers a handler. */
  it('provides the transport members the editor reaches for', () => {
    for (const member of ['setOpenToken', 'setSessionToken', 'reconnectionAttempts', 'timeout', 'transports']) {
      assert.match(source, new RegExp(member), `socket.io.${member} is missing`);
    }
  });

  /**
   * Saving is what needs this. Left unanswered, the engine decides no server
   * is listening and asks a desktop host to write the file instead — and there
   * is none, so the save fails with a message about the wrong thing entirely.
   */
  it('answers the messages a save is made of', () => {
    for (const type of ['saveChanges', 'isSaveLock', 'getLock', 'unSaveLock']) {
      assert.match(source, new RegExp(`'${type}'`), `${type} goes unanswered`);
    }
    assert.match(source, /syncChangesIndex/, 'an accepted batch must carry its index');
  });

  it('is valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(source));
  });
});
