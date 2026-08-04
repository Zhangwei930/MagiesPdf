const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const { documentUrls, resolveAsset, socketStubSource } = require('./editorAssets.cjs');

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

  it('is valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(source));
  });
});
