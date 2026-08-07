'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRendererApprovalPrompt } = require('./rendererApprovalPrompt.cjs');

function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };
}

const call = { functionName: 'office_excel_write', toolId: 'office:excel:write', path: '555.xlsx' };

describe('createRendererApprovalPrompt', () => {
  it('asks the window and resolves with what the user chose', async () => {
    const window = fakeWindow();
    let seq = 0;
    const prompt = createRendererApprovalPrompt({
      getWindow: () => window,
      createId: () => `ask-${(seq += 1)}`,
    });

    const answer = prompt.prompt(call);
    assert.deepEqual(window.sent[0][0], 'office:toolApproval');
    assert.equal(window.sent[0][1].approvalId, 'ask-1');
    assert.equal(window.sent[0][1].functionName, 'office_excel_write');
    assert.equal(window.sent[0][1].path, '555.xlsx');

    assert.equal(prompt.respond('ask-1', 'session'), true);
    assert.equal(await answer, 'session');
    // The same answer cannot be delivered twice.
    assert.equal(prompt.respond('ask-1', 'once'), false);
  });

  it('denies when there is no window to ask', async () => {
    const prompt = createRendererApprovalPrompt({ getWindow: () => null });
    assert.equal(await prompt.prompt(call), 'deny');

    const destroyed = createRendererApprovalPrompt({
      getWindow: () => ({ isDestroyed: () => true, webContents: { send: () => {} } }),
    });
    assert.equal(await destroyed.prompt(call), 'deny');
  });

  it('treats an unknown answer as a refusal', async () => {
    const window = fakeWindow();
    const prompt = createRendererApprovalPrompt({ getWindow: () => window, createId: () => 'ask-1' });
    const answer = prompt.prompt(call);
    prompt.respond('ask-1', 'whatever-the-renderer-sent');
    assert.equal(await answer, 'deny');
  });

  it('gives up on its own and tells the window to drop the card', async () => {
    const window = fakeWindow();
    const prompt = createRendererApprovalPrompt({
      getWindow: () => window,
      createId: () => 'ask-1',
      timeoutMs: 10,
    });
    assert.equal(await prompt.prompt(call), 'deny');
    assert.deepEqual(window.sent.at(-1), ['office:toolApprovalCleared', { approvalId: 'ask-1' }]);
  });

  it('settles everything as denied when asked to clear', async () => {
    const window = fakeWindow();
    let seq = 0;
    const prompt = createRendererApprovalPrompt({
      getWindow: () => window,
      createId: () => `ask-${(seq += 1)}`,
    });
    const first = prompt.prompt(call);
    const second = prompt.prompt(call);
    prompt.clear();
    assert.deepEqual(await Promise.all([first, second]), ['deny', 'deny']);
  });
});
