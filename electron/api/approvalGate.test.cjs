'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createApprovalGate } = require('./approvalGate.cjs');

const call = { functionName: 'office_excel_write', toolId: 'office:excel:write', path: '555.xlsx' };

describe('createApprovalGate', () => {
  it('denies when no prompt can be shown', async () => {
    const gate = createApprovalGate({ prompt: null });
    assert.equal(await gate.request(call), false);
  });

  it('allows a single call without remembering it', async () => {
    const asked = [];
    const gate = createApprovalGate({
      prompt: async (request) => {
        asked.push(request.functionName);
        return 'once';
      },
    });
    assert.equal(await gate.request(call), true);
    assert.equal(await gate.request(call), true);
    assert.deepEqual(asked, ['office_excel_write', 'office_excel_write']);
  });

  it('covers every tool for the rest of the run once granted', async () => {
    // Building a deck calls a dozen different tools. A grant that only covered
    // the one tool in front of the user would keep asking for each of them,
    // which is not what "allow for this run" says.
    const asked = [];
    const gate = createApprovalGate({
      prompt: async (request) => {
        asked.push(request.functionName);
        return 'session';
      },
    });
    assert.equal(await gate.request(call), true);
    assert.equal(await gate.request({ ...call, functionName: 'office_presentation_add_slide' }), true);
    assert.equal(await gate.request({ ...call, functionName: 'office_word_replace' }), true);
    assert.deepEqual(asked, ['office_excel_write'], 'asked once, not once per tool');
  });

  it('forgets session grants on reset', async () => {
    let asked = 0;
    const gate = createApprovalGate({
      prompt: async () => {
        asked += 1;
        return 'session';
      },
    });
    await gate.request(call);
    gate.reset();
    await gate.request(call);
    assert.equal(asked, 2);
  });

  it('denies when the prompt fails or times out', async () => {
    const failing = createApprovalGate({ prompt: async () => { throw new Error('no window'); } });
    assert.equal(await failing.request(call), false);

    const stalled = createApprovalGate({
      prompt: () => new Promise(() => {}),
      timeoutMs: 10,
    });
    assert.equal(await stalled.request(call), false);
  });

  it('asks one question at a time so a session grant settles the queue', async () => {
    let open = 0;
    const gate = createApprovalGate({
      prompt: async () => {
        open += 1;
        assert.equal(open, 1, 'prompts must not stack');
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        return 'session';
      },
    });
    const answers = await Promise.all([gate.request(call), gate.request(call), gate.request(call)]);
    assert.deepEqual(answers, [true, true, true]);
  });
});
