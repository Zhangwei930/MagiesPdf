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
