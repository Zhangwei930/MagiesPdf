const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const { documentUrls, editorPageSource, resolveAsset, socketStubSource } = require('./editorAssets.cjs');

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
 * The cloud engine fetches fonts over http, concatenating its font base onto
 * each entry of the font manifest. Those entries are absolute paths to files
 * on this machine, so the url that arrives has one glued onto the other —
 * which is a font request, not a request for something under the editors.
 */
describe('a font request', () => {
  const roots = { editors: '/engine/editors', sessions: {} };

  it('resolves to the file the manifest named', () => {
    assert.equal(
      resolveAsset('/editors/fonts/System/Library/Fonts/Osaka.ttf', roots),
      '/System/Library/Fonts/Osaka.ttf',
    );
  });

  it('takes the path back out of its url encoding', () => {
    assert.equal(
      resolveAsset('/editors/fonts/Users/me/Library/Fonts/My%20Font.otf', roots),
      '/Users/me/Library/Fonts/My Font.otf',
    );
  });

  /** Without this the route reads any file on the machine by absolute path. */
  it('refuses anything that is not a font', () => {
    assert.equal(resolveAsset('/editors/fonts/etc/passwd', roots), '');
    assert.equal(resolveAsset('/editors/fonts/Users/me/.ssh/id_rsa', roots), '');
  });

  it('still serves the engine itself from under the editors', () => {
    assert.equal(
      resolveAsset('/editors/sdkjs/word/sdk-all.js', roots),
      '/engine/editors/sdkjs/word/sdk-all.js',
    );
  });
});

/**
 * The engine's entry script ships as a template, because a server normally
 * renders a build hash into it. There is one version here and nothing to bust
 * a cache against, and the template skips that substitution when it is left
 * alone — so it is served as it is, under the name the page asks for.
 */
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
  const page = editorPageSource({ documentType: 'word', title: '报告.docx', fileType: 'docx' });

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
