const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const { createEditorHost } = require('./editorHost.cjs');
const { listenLoopback } = require('./editorRuntime.cjs');

/**
 * Drives the real loopback server the renderer will talk to.
 *
 * The unit tests describe what should be served; this shows that it is, over
 * HTTP, with the paths the editor actually requests. It uses a fabricated
 * engine directory rather than the vendored one so it runs anywhere.
 */

describe('serving the editor over loopback', () => {
  let root = '';
  let host = null;
  let base = '';

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'magies-editor-'));
    const editors = path.join(root, 'editors', 'web-apps', 'vendor', 'socketio');
    await fsp.mkdir(editors, { recursive: true });
    await fsp.writeFile(path.join(editors, 'socket.io.min.js'), '/* the real one */');
    await fsp.mkdir(path.join(root, 'editors', 'sdkjs', 'word'), { recursive: true });
    await fsp.writeFile(path.join(root, 'editors', 'sdkjs', 'word', 'sdk-all-min.js'), 'ENGINE');

    const work = path.join(root, 'work');
    await fsp.mkdir(path.join(work, 'media'), { recursive: true });
    await fsp.writeFile(path.join(work, 'Editor.bin'), 'DOCY;v1;0;');
    await fsp.writeFile(path.join(work, 'media', 'image1.png'), 'PNGDATA');

    host = createEditorHost({
      editorsRoot: path.join(root, 'editors'),
      listen: listenLoopback,
      registerFontProtocol: () => {},
    });
    const published = await host.publish({ id: 'doc1', workDir: work, media: ['image1.png'] });
    base = new URL(published.url).origin;
  });

  after(async () => {
    await host?.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const get = async (route) => {
    const response = await fetch(base + route);
    return { status: response.status, body: await response.text() };
  };

  it('serves the engine', async () => {
    const { status, body } = await get('/editors/sdkjs/word/sdk-all-min.js');
    assert.equal(status, 200);
    assert.equal(body, 'ENGINE');
  });

  it('serves the converted document', async () => {
    const { status, body } = await get('/session/doc1/Editor.bin');
    assert.equal(status, 200);
    assert.equal(body, 'DOCY;v1;0;');
  });

  /** The editor asks for images by their map key, not by the url it was given. */
  it('serves an image asked for by its map key', async () => {
    const { status, body } = await get('/media/image1.png');
    assert.equal(status, 200);
    assert.equal(body, 'PNGDATA');
  });

  it('replaces socket.io with the stand-in that carries the document', async () => {
    const { status, body } = await get('/editors/web-apps/vendor/socketio/socket.io.min.js');
    assert.equal(status, 200);
    assert.notEqual(body, '/* the real one */', 'the real socket.io must not reach the editor');
    assert.match(body, /documentOpen/);
    assert.match(body, /\/session\/doc1\/Editor\.bin/);
    assert.match(body, /"type":"license"/);
  });

  it('refuses to serve outside its roots', async () => {
    assert.equal((await get('/editors/../../../etc/passwd')).status, 404);
    assert.equal((await get('/session/doc1/../../../etc/passwd')).status, 404);
  });

  it('stops answering for a document once it is withdrawn', async () => {
    host.withdraw('doc1');
    assert.equal((await get('/session/doc1/Editor.bin')).status, 404);
  });

  it('is listening on loopback only', () => {
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('releases the port when the last document goes', async () => {
    await host.close();
    await assert.rejects(() => fetch(base + '/editors/sdkjs/word/sdk-all-min.js'));
  });
});
