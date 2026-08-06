import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EMPTY_APPROVAL_STATE,
  MAX_APPROVAL_RECORDS,
  approvalSubject,
  withDecision,
  withRequest,
  withTimeout,
} from './officeApprovals.ts';

const request = (approvalId: string, functionName = 'office_excel_write') => ({
  approvalId,
  functionName,
  toolId: 'office:excel:write',
  path: '555.xlsx',
});

describe('office approval state', () => {
  it('queues a request once, however many times it arrives', () => {
    const once = withRequest(EMPTY_APPROVAL_STATE, request('a'));
    const twice = withRequest(once, request('a'));
    assert.equal(twice.pending.length, 1);
    assert.equal(twice, once, 'a duplicate leaves the state untouched');
  });

  it('turns an answer into a record and clears the card', () => {
    const pending = withRequest(EMPTY_APPROVAL_STATE, request('a'));
    const answered = withDecision(pending, 'a', 'session', 1000);
    assert.deepEqual(answered.pending, []);
    assert.deepEqual(answered.records, [{
      approvalId: 'a',
      functionName: 'office_excel_write',
      path: '555.xlsx',
      decision: 'session',
      at: 1000,
    }]);
  });

  it('records a timeout as the refusal the caller was given', () => {
    const pending = withRequest(EMPTY_APPROVAL_STATE, request('a'));
    const expired = withTimeout(pending, 'a', 2000);
    assert.equal(expired.pending.length, 0);
    assert.equal(expired.records[0]?.decision, 'timeout');
    // An id that is not pending changes nothing.
    assert.equal(withTimeout(expired, 'a', 3000), expired);
    assert.equal(withDecision(expired, 'a', 'once', 3000), expired);
  });

  it('keeps the newest decisions first and caps the trail', () => {
    let state = EMPTY_APPROVAL_STATE;
    for (let index = 0; index < MAX_APPROVAL_RECORDS + 5; index += 1) {
      state = withRequest(state, request(`id-${index}`));
      state = withDecision(state, `id-${index}`, 'once', index);
    }
    assert.equal(state.records.length, MAX_APPROVAL_RECORDS);
    assert.equal(state.records[0]?.approvalId, `id-${MAX_APPROVAL_RECORDS + 4}`);
  });

  it('says what the call would do, not which function it is', () => {
    assert.equal(approvalSubject('office_excel_write', 'zh'), '修改 Excel 表格');
    assert.equal(approvalSubject('office_excel_read', 'zh'), '读取 Excel 表格');
    assert.equal(approvalSubject('office_presentation_add_slide', 'en'), 'Modify a presentation');
    assert.equal(approvalSubject('office_workspace_list', 'en'), 'Read workspace files');
  });
});
