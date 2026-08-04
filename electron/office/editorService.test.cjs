const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createEditorService } = require('./editorService.cjs');

function dependencies(overrides = {}) {
  const calls = { opened: [], published: [], withdrawn: [], saved: [], closed: [] };
  const deps = {
    sessions: {
      open: async (sourcePath) => {
        calls.opened.push(sourcePath);
        return {
          id: 'sess1',
          path: sourcePath,
          name: sourcePath.split('/').pop(),
          editorType: 'word',
          binPath: '/tmp/w/Editor.bin',
          workDir: '/tmp/w',
        };
      },
      get: (id) => ({ id, path: '/docs/a.docx', name: 'a.docx', workDir: '/tmp/w', binPath: '/tmp/w/Editor.bin' }),
      save: async (id) => {
        calls.saved.push(id);
        return { id, path: '/docs/a.docx', name: 'a.docx' };
      },
      close: async (id) => {
        calls.closed.push(id);
        return { closed: id };
      },
      writeEditorBin: async () => undefined,
    },
    host: {
      publish: async (session) => {
        calls.published.push(session);
        return { url: `http://127.0.0.1:9/editor/${session.id}` };
      },
      withdraw: (id) => calls.withdrawn.push(id),
      focus: () => {},
    },
    listMedia: async () => ['image1.png'],
    ...overrides,
  };
  return { calls, deps };
}

describe('opening a document in the editor', () => {
  it('converts it, publishes it, and says where to point', async () => {
    const { calls, deps } = dependencies();
    const service = createEditorService(deps);

    const [file] = await service.open(['/docs/a.docx']);

    assert.deepEqual(calls.opened, ['/docs/a.docx']);
    assert.equal(file.name, 'a.docx');
    assert.equal(file.path, '/docs/a.docx');
    assert.deepEqual(file.editor, { sessionId: 'sess1', url: 'http://127.0.0.1:9/editor/sess1' });
  });

  /** The tab holds no bytes: they are in the engine's work directory. */
  it('hands over no bytes', async () => {
    const { deps } = dependencies();
    const [file] = await createEditorService(deps).open(['/docs/a.docx']);
    assert.equal(file.bytes.length, 0);
    assert.equal(file.size, 0);
  });

  it('tells the host which images the document extracted', async () => {
    const { calls, deps } = dependencies();
    await createEditorService(deps).open(['/docs/a.docx']);
    assert.deepEqual(calls.published[0].media, ['image1.png']);
  });

  it('opens every path it is given', async () => {
    const { calls, deps } = dependencies();
    const files = await createEditorService(deps).open(['/docs/a.docx', '/docs/b.pptx']);
    assert.equal(files.length, 2);
    assert.deepEqual(calls.opened, ['/docs/a.docx', '/docs/b.pptx']);
  });
});

describe('closing a document', () => {
  it('withdraws it from the host and discards the work directory', async () => {
    const { calls, deps } = dependencies();
    const service = createEditorService(deps);

    await service.close('sess1');

    assert.deepEqual(calls.withdrawn, ['sess1']);
    assert.deepEqual(calls.closed, ['sess1']);
  });

  /**
   * Withdrawing first means a late request from a closing editor gets a 404
   * rather than reading from a directory being deleted underneath it.
   */
  it('stops serving before it deletes', async () => {
    const order = [];
    const { deps } = dependencies({
      host: { publish: async () => ({ url: '' }), withdraw: () => order.push('withdraw'), focus: () => {} },
      sessions: {
        open: async () => ({ id: 's', workDir: '/tmp/w' }),
        get: () => ({ id: 's' }),
        save: async () => ({}),
        close: async () => order.push('close'),
        writeEditorBin: async () => undefined,
      },
    });

    await createEditorService(deps).close('sess1');

    assert.deepEqual(order, ['withdraw', 'close']);
  });
});

describe('saving from the editor', () => {
  it('writes what the engine produced, then converts it back', async () => {
    const order = [];
    const { deps } = dependencies({
      sessions: {
        open: async () => ({ id: 's', workDir: '/tmp/w' }),
        get: (id) => ({ id, path: '/docs/a.docx', name: 'a.docx' }),
        writeEditorBin: async () => order.push('write'),
        save: async () => {
          order.push('save');
          return { path: '/docs/a.docx', name: 'a.docx' };
        },
        close: async () => undefined,
      },
    });

    const result = await createEditorService(deps).save('sess1', 'YmFzZTY0');

    assert.deepEqual(order, ['write', 'save'], 'the bytes must land before they are converted');
    assert.equal(result.path, '/docs/a.docx');
  });
});
