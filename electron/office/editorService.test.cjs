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
    assert.deepEqual(file.editor, {
      sessionId: 'sess1',
      url: 'http://127.0.0.1:9/editor/sess1',
      editorType: 'word',
    });
  });

  /**
   * The shell's "New" needs the document kind. Without it on the tab, every
   * new document would be Word regardless of what is open.
   */
  it('carries the engine type the session already knows', async () => {
    const { deps } = dependencies({
      sessions: {
        open: async (sourcePath) => ({
          id: 'sess-cell',
          path: sourcePath,
          name: 'book.xlsx',
          editorType: 'cell',
          binPath: '/tmp/w/Editor.bin',
          workDir: '/tmp/w',
        }),
        get: () => ({}),
        save: async () => ({}),
        close: async () => ({}),
        writeEditorBin: async () => undefined,
      },
    });
    const [file] = await createEditorService(deps).open(['/docs/book.xlsx']);
    assert.equal(file.editor.editorType, 'cell');
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

  /**
   * Recent documents used to be written only by the old PDF-preview open path.
   * Opening in the editor is the real path now, so it has to remember too —
   * otherwise the start centre stays empty after every open.
   */
  it('remembers the paths it opened', async () => {
    const remembered = [];
    const { deps } = dependencies({
      rememberPaths: (paths) => remembered.push(...paths),
    });
    await createEditorService(deps).open(['/docs/a.docx', '/docs/b.xlsx']);
    assert.deepEqual(remembered, ['/docs/a.docx', '/docs/b.xlsx']);
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

  /**
   * Saving under another name is the file menu's "save as", and it is two
   * steps: the document has to come out of the engine before it can be
   * written anywhere. Writing first would save whatever the last save left
   * behind — the edits since would be missing, silently.
   */
  it('takes the document out of the engine before writing it elsewhere', async () => {
    const order = [];
    const service = createEditorService({
      sessions: {
        writeEditorBin: async () => { order.push('write'); },
        saveAs: async (id, target) => { order.push(`saveAs:${target}`); return { path: target }; },
        save: async () => ({}),
        open: async () => ({}),
        close: async () => ({}),
      },
      host: { publish: async () => ({ url: '' }), withdraw: () => {} },
      listMedia: async () => [],
    });

    await service.saveAs('abc', 'ZG9j', '/tmp/copy.pdf');
    assert.deepEqual(order, ['write', 'saveAs:/tmp/copy.pdf']);
  });

  /**
   * "Save copy as" has already produced the file the user wants. Writing it
   * must not go through the converter — the bytes are a finished PDF or DOCX.
   */
  it('writes a finished export straight to disk', async () => {
    const written = [];
    const service = createEditorService({
      sessions: {
        open: async () => ({}),
        close: async () => ({}),
        save: async () => ({}),
        writeEditorBin: async () => { throw new Error('export is not the editor binary'); },
        exportTo: async () => { throw new Error('PDF should not be converted'); },
      },
      host: {
        publish: async () => ({ url: '' }),
        withdraw: () => {},
        consumeExport: (id) => {
          assert.equal(id, 'sess1');
          return { bytes: Buffer.from('%PDF-export'), title: 'a.pdf' };
        },
      },
      listMedia: async () => [],
      fs: {
        writeFile: async (target, bytes) => { written.push([target, bytes.toString()]); },
      },
    });

    const result = await service.writeExport('sess1', '/docs/copy.pdf');
    assert.deepEqual(written, [['/docs/copy.pdf', '%PDF-export']]);
    assert.equal(result.path, '/docs/copy.pdf');
    assert.equal(result.name, 'copy.pdf');
  });

  it('converts an editor-binary export through the session without moving the tab', async () => {
    const service = createEditorService({
      sessions: {
        open: async () => ({}),
        close: async () => ({}),
        save: async () => ({}),
        exportTo: async (id, bytes, target) => {
          assert.equal(id, 'sess1');
          assert.equal(bytes.toString(), 'DOCY;bin');
          return { path: target, name: 'copy.xlsx' };
        },
      },
      host: {
        publish: async () => ({ url: '' }),
        withdraw: () => {},
        consumeExport: () => ({ bytes: Buffer.from('DOCY;bin'), title: 'a.xlsx' }),
      },
      listMedia: async () => [],
      fs: { writeFile: async () => { throw new Error('must convert, not write raw'); } },
    });

    const result = await service.writeExport('sess1', '/docs/copy.xlsx');
    assert.equal(result.path, '/docs/copy.xlsx');
  });
});
