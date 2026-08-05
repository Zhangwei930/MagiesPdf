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
      method: 'POST',
      body: Buffer.from('DOCY;whole'),
      command: { savetype: 3 },
    });

    assert.equal(answer.status, 200, 'the engine is told the save failed');
    assert.equal(saved.length, 1, 'nothing reached the shell');
    assert.equal(saved[0][0], 'abc');
    assert.equal(saved[0][1].toString(), 'DOCY;whole');
  });

  /**
   * The engine blocks the editor behind a progress dialog for the length of
   * the operation, and ends it when the reply names the file it produced.
   * Acknowledging without one leaves the dialog up over a document that has
   * in fact already been written.
   */
  it('answers a finished save with the file it produced', async () => {
    const { calls, deps } = dependencies({ onDocumentSaved: async () => {} });
    const host = createEditorHost(deps);
    await host.publish({ id: 'abc', workDir: '/tmp/abc', media: [], fileType: 'docx' });

    const answer = await calls.listened[0]({
      path: '/editors/downloadas/abc',
      method: 'POST',
      body: Buffer.from('DOCY;whole'),
      command: { c: 'save', savetype: 3 },
    });

    const reply = JSON.parse(answer.body);
    assert.equal(reply.type, 'save', 'the engine matches the reply to the command it sent');
    assert.equal(reply.status, 'ok');
    assert.ok(reply.data, 'without a file the dialog never closes');
  });

  /** A chunk that is not the last one is only acknowledged. */
  it('does not claim a file while parts are still arriving', async () => {
    const { calls, deps } = dependencies({ onDocumentSaved: async () => {} });
    const host = createEditorHost(deps);
    await host.publish({ id: 'abc', workDir: '/tmp/abc', media: [] });

    const answer = await calls.listened[0]({
      path: '/editors/downloadas/abc',
      method: 'POST',
      body: Buffer.from('DOCY;'),
      command: { c: 'save', savetype: 0 },
    });
    assert.equal(JSON.parse(answer.body).status, 'ok');
    assert.ok(JSON.parse(answer.body).data, 'multi-part needs a save key');
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
      method: 'POST',
      body: Buffer.from('DOCY;whole'),
      command: { savetype: 3 },
    });
    assert.equal(saved.length, 1);
  });

  /**
   * "Save copy as" uploads a finished export (PDF, DOCX, …). Treating that as
   * the editor binary and writing it over the open file is what made the menu
   * item appear to do nothing — conversion failed and the dialog never closed.
   */
  it('keeps a save-copy upload off the session path', async () => {
    const saved = [];
    const { calls, deps } = dependencies({
      onDocumentSaved: async (id, bytes) => { saved.push([id, bytes]); },
    });
    const host = createEditorHost(deps);
    await host.publish({ id: 'abc', workDir: '/tmp/abc', media: [], title: '报告.docx' });

    const answer = await calls.listened[0]({
      path: '/editors/downloadas/abc',
      method: 'POST',
      body: Buffer.from('%PDF-1.4 copy'),
      command: { c: 'save', savetype: 3, isSaveAs: true, title: '报告.pdf' },
    });

    assert.equal(saved.length, 0, 'must not write the export over the open document');
    assert.equal(JSON.parse(answer.body).status, 'ok');

    const taken = host.consumeExport('abc');
    assert.equal(taken.bytes.toString(), '%PDF-1.4 copy');
    assert.equal(taken.title, '报告.pdf');
  });

  it('serves the export at the URL the reply named', async () => {
    const { calls, deps } = dependencies({ onDocumentSaved: async () => {} });
    const host = createEditorHost(deps);
    await host.publish({ id: 'abc', workDir: '/tmp/abc', media: [] });

    await calls.listened[0]({
      path: '/editors/downloadas/abc',
      method: 'POST',
      body: Buffer.from('exported-bytes'),
      command: { c: 'save', savetype: 3, isSaveAs: true, title: 'a.pdf' },
    });

    const answer = await calls.listened[0]({
      path: '/editors/downloadas/abc/saved',
      method: 'GET',
      body: Buffer.alloc(0),
      command: {},
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.toString(), 'exported-bytes');
  });

  it('answers intermediate parts with a save key so multi-part downloads continue', async () => {
    const { calls, deps } = dependencies({ onDocumentSaved: async () => {} });
    const host = createEditorHost(deps);
    await host.publish({ id: 'abc', workDir: '/tmp/abc', media: [] });

    const answer = await calls.listened[0]({
      path: '/editors/downloadas/abc',
      method: 'POST',
      body: Buffer.from('part-'),
      command: { c: 'save', savetype: 0 },
    });
    const reply = JSON.parse(answer.body);
    assert.equal(reply.status, 'ok');
    assert.equal(reply.type, 'save');
    assert.ok(reply.data, 'without a save key the next part never starts');
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

  /**
   * Warm starts the host without a document so the renderer can prefetch
   * static engine assets before the user opens anything.
   */
  it('warms the host without opening a document', async () => {
    const { deps } = dependencies();
    const host = createEditorHost(deps);

    const warmed = await host.warm();
    assert.match(warmed.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(warmed.url, `${warmed.origin}/warm`);
    assert.ok(warmed.prefetch.some((p) => p.includes('sdk-all-min.js')));
    assert.equal(host.sessions().length, 0);
  });
});

describe('warm page HTML', () => {
  const { warmPageSource } = require('./editorHost.cjs');

  it('preloads the engine assets the first open would fetch', () => {
    const html = warmPageSource([
      '/editors/sdkjs/word/sdk-all-min.js',
      '/editors/web-apps/apps/documenteditor/main/resources/css/app.css',
    ]);
    assert.match(html, /rel="preload"/);
    assert.match(html, /as="script"/);
    assert.match(html, /as="style"/);
    assert.match(html, /sdk-all-min\.js/);
  });
});
