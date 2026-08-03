const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createOfficeSessions, editorTypeFor } = require('./session.cjs');

function dependencies(overrides = {}) {
  const calls = { converted: [], restored: [], discarded: [], written: [] };
  let nextId = 0;
  const deps = {
    x2t: {
      toEditorFormat: async (sourcePath) => {
        calls.converted.push(sourcePath);
        return { binPath: `/tmp/magies/w${nextId}/Editor.bin`, workDir: `/tmp/magies/w${nextId}` };
      },
      fromEditorFormat: async (binPath, targetPath) => {
        calls.restored.push([binPath, targetPath]);
        return targetPath;
      },
      discard: async (workDir) => calls.discarded.push(workDir),
    },
    fs: {
      writeFile: async (target, bytes) => calls.written.push([target, bytes]),
      readFile: async () => Buffer.from('bin-bytes'),
      stat: async () => ({ isFile: () => true }),
    },
    uniqueId: () => `s${nextId += 1}`,
    ...overrides,
  };
  return { calls, deps };
}

describe('editor type', () => {
  /** The three editors the suite ships; the id is what web-apps expects. */
  it('routes each document kind to its editor', () => {
    assert.equal(editorTypeFor('/a/b.docx'), 'word');
    assert.equal(editorTypeFor('/a/b.rtf'), 'word');
    assert.equal(editorTypeFor('/a/b.xlsx'), 'cell');
    assert.equal(editorTypeFor('/a/b.ods'), 'cell');
    assert.equal(editorTypeFor('/a/b.pptx'), 'slide');
    assert.equal(editorTypeFor('/a/b.odp'), 'slide');
    assert.equal(editorTypeFor('/a/b.txt'), '');
  });
});

describe('Office sessions', () => {
  it('opens a document into an editable session', async () => {
    const { calls, deps } = dependencies();
    const sessions = createOfficeSessions(deps);

    const session = await sessions.open('/docs/report.docx');

    assert.equal(session.id, 's1');
    assert.equal(session.path, '/docs/report.docx');
    assert.equal(session.name, 'report.docx');
    assert.equal(session.editorType, 'word');
    assert.equal(session.modified, false);
    assert.deepEqual(calls.converted, ['/docs/report.docx']);
  });

  it('refuses a document no editor can open', async () => {
    const { deps } = dependencies();
    const sessions = createOfficeSessions(deps);
    await assert.rejects(() => sessions.open('/docs/notes.txt'), /unsupported/i);
  });

  it('keeps sessions apart so several documents can be open at once', async () => {
    const { deps } = dependencies();
    const sessions = createOfficeSessions(deps);

    const first = await sessions.open('/docs/a.docx');
    const second = await sessions.open('/docs/b.xlsx');

    assert.notEqual(first.id, second.id);
    assert.equal(sessions.get(first.id).path, '/docs/a.docx');
    assert.equal(sessions.get(second.id).editorType, 'cell');
    assert.equal(sessions.list().length, 2);
  });

  it('rejects an unknown session rather than returning nothing', () => {
    const { deps } = dependencies();
    const sessions = createOfficeSessions(deps);
    assert.throws(() => sessions.get('nope'), /unknown/i);
  });

  it('writes the bytes the editor produced into the session work directory', async () => {
    const { calls, deps } = dependencies();
    const sessions = createOfficeSessions(deps);
    const session = await sessions.open('/docs/report.docx');

    await sessions.writeEditorBin(session.id, Buffer.from('edited').toString('base64'));

    const [target, bytes] = calls.written.at(-1);
    assert.equal(target, session.binPath);
    assert.equal(Buffer.from(bytes).toString(), 'edited');
  });

  it('saves back over the file the document came from', async () => {
    const { calls, deps } = dependencies();
    const sessions = createOfficeSessions(deps);
    const session = await sessions.open('/docs/report.docx');
    sessions.setModified(session.id, true);

    const saved = await sessions.save(session.id);

    assert.equal(saved.path, '/docs/report.docx');
    assert.deepEqual(calls.restored, [[session.binPath, '/docs/report.docx']]);
    assert.equal(sessions.get(session.id).modified, false);
  });

  it('follows the document to its new home after Save As', async () => {
    const { calls, deps } = dependencies();
    const sessions = createOfficeSessions(deps);
    const session = await sessions.open('/docs/report.docx');

    const saved = await sessions.saveAs(session.id, '/docs/copy.docx');

    assert.equal(saved.path, '/docs/copy.docx');
    assert.equal(saved.name, 'copy.docx');
    assert.deepEqual(calls.restored, [[session.binPath, '/docs/copy.docx']]);
    // A later plain save must go to the new file, not the original.
    await sessions.save(session.id);
    assert.deepEqual(calls.restored.at(-1), [session.binPath, '/docs/copy.docx']);
  });

  it('refuses Save As into a format the suite cannot write', async () => {
    const { deps } = dependencies();
    const sessions = createOfficeSessions(deps);
    const session = await sessions.open('/docs/report.docx');
    await assert.rejects(() => sessions.saveAs(session.id, '/docs/copy.exe'), /unsupported/i);
  });

  it('discards the work directory when a document is closed', async () => {
    const { calls, deps } = dependencies();
    const sessions = createOfficeSessions(deps);
    const session = await sessions.open('/docs/report.docx');

    await sessions.close(session.id);

    assert.deepEqual(calls.discarded, [session.workDir]);
    assert.throws(() => sessions.get(session.id), /unknown/i);
  });

  /**
   * Closing every tab must not leave a copy of the user's document in temp,
   * so shutdown discards whatever is still open.
   */
  it('discards every open work directory on shutdown', async () => {
    const { calls, deps } = dependencies();
    const sessions = createOfficeSessions(deps);
    const first = await sessions.open('/docs/a.docx');
    const second = await sessions.open('/docs/b.docx');

    await sessions.closeAll();

    assert.deepEqual(calls.discarded.sort(), [first.workDir, second.workDir].sort());
    assert.equal(sessions.list().length, 0);
  });
});
