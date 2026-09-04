const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createDocumentSavedHandler } = require('./documentSaved.cjs');

function harness(overrides = {}) {
  const sent = [];
  const remembered = [];
  const targets = new Map(overrides.targets ?? []);
  const handler = createDocumentSavedHandler({
    takeSaveAsTarget: (sessionId) => {
      const target = targets.get(sessionId);
      targets.delete(sessionId);
      return target;
    },
    save: overrides.save ?? (async () => ({ path: '/docs/report.docx', name: 'report.docx' })),
    saveAs: overrides.saveAs ?? (async () => ({ path: '/docs/copy.docx', name: 'copy.docx' })),
    rememberRecent: (paths) => remembered.push(...paths),
    notify: (channel, payload) => sent.push({ channel, payload }),
  });
  return { handler, sent, remembered, targets };
}

const bytes = Buffer.from('document');

describe('a document coming back from the engine', () => {
  it('writes it and tells the renderer where it went', async () => {
    const { handler, sent, remembered } = harness();

    await handler('s1', bytes);

    assert.deepEqual(sent, [
      {
        channel: 'office:editorSaved',
        payload: { sessionId: 's1', path: '/docs/report.docx', name: 'report.docx' },
      },
    ]);
    assert.deepEqual(remembered, ['/docs/report.docx']);
  });

  it('routes through save-as when a target was chosen, once', async () => {
    const { handler, sent, targets } = harness({ targets: [['s1', '/docs/copy.docx']] });

    await handler('s1', bytes);
    assert.equal(sent[0].payload.path, '/docs/copy.docx');
    assert.equal(targets.has('s1'), false, 'the target is consumed');

    await handler('s1', bytes);
    assert.equal(sent[1].payload.path, '/docs/report.docx', 'the next save is an ordinary one');
  });

  /**
   * A save fails for ordinary reasons: a full disk, a file gone read-only, a
   * converter that quit. The renderer has to hear about it, or the tab keeps
   * showing the document as saved while the disk still holds the old bytes —
   * and closing it later asks nothing. See issue #23.
   */
  it('tells the renderer when the write fails, and still fails the request', async () => {
    const { handler, sent } = harness({
      save: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    await assert.rejects(() => handler('s1', bytes), /no space left on device/);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, 'office:editorSaveFailed');
    assert.equal(sent[0].payload.sessionId, 's1');
    assert.match(sent[0].payload.message, /no space left on device/);
  });

  it('reports a failed save-as the same way', async () => {
    const { handler, sent } = harness({
      targets: [['s1', '/read-only/copy.docx']],
      saveAs: async () => {
        throw new Error('EACCES: permission denied');
      },
    });

    await assert.rejects(() => handler('s1', bytes), /permission denied/);
    assert.equal(sent[0].channel, 'office:editorSaveFailed');
  });

  it('never reports success and failure for one save', async () => {
    const { handler, sent } = harness({
      save: async () => {
        throw new Error('converter exited with code 1');
      },
    });

    await assert.rejects(() => handler('s1', bytes));
    assert.equal(sent.filter((message) => message.channel === 'office:editorSaved').length, 0);
  });

  it('does not remember a path the save never produced', async () => {
    const { handler, remembered } = harness({ save: async () => ({}) });

    await handler('s1', bytes);
    assert.deepEqual(remembered, []);
  });
});
