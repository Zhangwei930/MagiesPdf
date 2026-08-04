const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createEditorHost } = require('./editorHost.cjs');

function dependencies(overrides = {}) {
  const calls = { listened: [], closed: 0 };
  const deps = {
    editorsRoot: '/engine/editors',
    listen: async (handler) => {
      calls.listened.push(handler);
      return { port: 51234, close: async () => { calls.closed += 1; } };
    },
    ...overrides,
  };
  return { calls, deps };
}

/**
 * Where the engine actually posts a document back.
 *
 * It resolves the upload url against the page it is running in, which is
 * served from under the editors — so what arrives is `/editors/downloadas/…`
 * rather than the bare path. Answering only the bare one is a 404 the engine
 * reports as a failure to save, with the document still only in the browser.
 */
describe('the route a document comes back on', () => {
  it('is accepted under the editors, where the engine resolves it', async () => {
    const saved = [];
    const { calls, deps } = dependencies({
      onDocumentSaved: async (id, bytes) => { saved.push([id, bytes]); },
    });
    const host = createEditorHost(deps);
    await host.publish({ id: 'abc', workDir: '/tmp/abc', media: [] });

    const handler = calls.listened[0];
    const answer = await handler({
      path: '/editors/downloadas/abc',
      body: Buffer.from('DOCY;whole'),
      command: { savetype: 3 },
    });

    assert.equal(answer.status, 200, 'the engine is told the save failed');
    assert.equal(saved.length, 1, 'nothing reached the shell');
    assert.equal(saved[0][0], 'abc');
    assert.equal(saved[0][1].toString(), 'DOCY;whole');
  });

  it('still accepts the bare route', async () => {
    const saved = [];
    const { calls, deps } = dependencies({
      onDocumentSaved: async (id, bytes) => { saved.push([id, bytes]); },
    });
    const host = createEditorHost(deps);
    await host.publish({ id: 'abc', workDir: '/tmp/abc', media: [] });

    await calls.listened[0]({
      path: '/downloadas/abc',
      body: Buffer.from('DOCY;whole'),
      command: { savetype: 3 },
    });
    assert.equal(saved.length, 1);
  });
});

describe('the editor host', () => {
  it('is not listening until a document needs it', async () => {
    const { calls, deps } = dependencies();
    createEditorHost(deps);
    assert.equal(calls.listened.length, 0, 'no server before it is wanted');
  });

  it('starts once, however many documents open', async () => {
    const { calls, deps } = dependencies();
    const host = createEditorHost(deps);

    const first = await host.publish({ id: 'a', workDir: '/tmp/a', media: [] });
    const second = await host.publish({ id: 'b', workDir: '/tmp/b', media: [] });

    assert.equal(calls.listened.length, 1, 'the server is shared');
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:51234\//, 'loopback only');
    assert.notEqual(first.url, second.url, 'each document gets its own entry point');
  });

  it('stops serving a document once it is withdrawn', async () => {
    const { deps } = dependencies();
    const host = createEditorHost(deps);
    await host.publish({ id: 'a', workDir: '/tmp/a', media: [] });

    host.withdraw('a');

    assert.equal(host.sessions().length, 0);
  });

  it('closes the server when the last document goes', async () => {
    const { calls, deps } = dependencies();
    const host = createEditorHost(deps);
    await host.publish({ id: 'a', workDir: '/tmp/a', media: [] });

    await host.close();

    assert.equal(calls.closed, 1);
  });
});
