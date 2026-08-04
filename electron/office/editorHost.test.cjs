const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createEditorHost, fontFileFromUrl } = require('./editorHost.cjs');

function dependencies(overrides = {}) {
  const calls = { listened: [], closed: 0 };
  const deps = {
    editorsRoot: '/engine/editors',
    listen: async (handler) => {
      calls.listened.push(handler);
      return { port: 51234, close: async () => { calls.closed += 1; } };
    },
    registerFontProtocol: () => {},
    ...overrides,
  };
  return { calls, deps };
}

describe('font urls', () => {
  /**
   * The engine's font base is compiled into it as `ascdesktop://fonts/`, so the
   * paths in AllFonts.js arrive with that prefix rather than as plain paths.
   */
  it('recovers the file a font request names', () => {
    assert.equal(
      fontFileFromUrl('ascdesktop://fonts//System/Library/Fonts/Helvetica.ttc'),
      '/System/Library/Fonts/Helvetica.ttc',
    );
  });

  it('decodes a path with spaces', () => {
    assert.equal(
      fontFileFromUrl('ascdesktop://fonts//Library/Fonts/My%20Font.ttf'),
      '/Library/Fonts/My Font.ttf',
    );
  });

  /** Only fonts: this handler must not become a way to read any file. */
  it('refuses anything that is not a font file', () => {
    assert.equal(fontFileFromUrl('ascdesktop://fonts//etc/passwd'), '');
    assert.equal(fontFileFromUrl('ascdesktop://other//System/Library/Fonts/a.ttf'), '');
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
