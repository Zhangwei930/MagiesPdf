const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { connectMessages, documentMessages } = require('./editorHandshake.cjs');

/**
 * The editor loads a document by being told, not by asking: it opens a socket,
 * registers a handler and then waits. These builders are the messages a
 * document server would send, and every field in them was arrived at by
 * watching the editor fail without it — so they are pinned here rather than
 * left to be rediscovered.
 */

describe('the messages sent on connect', () => {
  it('opens with the transport handshake the client expects first', () => {
    const [handshake] = connectMessages({ sessionId: 's1' });
    assert.equal(handshake.sid, 's1');
    assert.equal(typeof handshake.pingInterval, 'number');
    assert.equal(typeof handshake.pingTimeout, 'number');
    assert.deepEqual(handshake.upgrades, []);
    assert.equal('type' in handshake, false, 'the transport packet carries no type');
  });

  /**
   * Without the licence the editor's controllers never finish setMode, and the
   * first thing to read `mode.canCoAuthoring` throws — which surfaces as an
   * opaque "changesError" long after the real cause.
   */
  it('sends a licence, without which the app layer never finishes starting', () => {
    const [, licence] = connectMessages({ sessionId: 's1' });
    assert.equal(licence.type, 'license');
    assert.equal(licence.license.rights, 1);
    assert.equal(licence.license.customization, true);
    assert.equal(licence.license.branding, false);
  });

  /** The Connector is a paid add-on; claiming it would be a lie to the editor. */
  it('does not claim the advanced API', () => {
    const [, licence] = connectMessages({ sessionId: 's1' });
    assert.equal(licence.license.advancedApi, false);
  });
});

describe('the messages that carry the document', () => {
  const urls = { 'Editor.bin': '/doc/Editor.bin', 'media/image1.png': '/doc/media/image1.png' };

  it('authenticates before opening', () => {
    const [changes, auth] = documentMessages({ sessionId: 's1', urls, user: { id: 'u', name: 'U' } });
    assert.equal(changes.type, 'authChanges');
    assert.equal(auth.type, 'auth');
    assert.equal(auth.result, 1);
    assert.equal(auth.sessionId, 's1');
  });

  it('describes the one participant, since nobody else is editing', () => {
    const [, auth] = documentMessages({ sessionId: 's1', urls, user: { id: 'u7', name: '张三' } });
    assert.equal(auth.participants.length, 1);
    assert.equal(auth.participants[0].id, 'u7');
    assert.equal(auth.participants[0].username, '张三');
    assert.equal(auth.participants[0].view, false);
  });

  it('hands over every part of the document', () => {
    const [, , open] = documentMessages({ sessionId: 's1', urls, user: { id: 'u', name: 'U' } });
    assert.equal(open.type, 'documentOpen');
    assert.equal(open.data.status, 'ok');
    assert.deepEqual(open.data.data, urls);
  });

  it('grants editing when the document is not read-only', () => {
    const [, auth] = documentMessages({ sessionId: 's1', urls, user: { id: 'u', name: 'U' } });
    assert.equal(auth.mode, 'edit');
    assert.equal(auth.permissions.edit, true);
  });

  it('withholds editing for a read-only document', () => {
    const [, auth] = documentMessages({
      sessionId: 's1', urls, user: { id: 'u', name: 'U' }, readOnly: true,
    });
    assert.equal(auth.mode, 'view');
    assert.equal(auth.permissions.edit, false);
    assert.equal(auth.participants[0].view, true);
  });
});
