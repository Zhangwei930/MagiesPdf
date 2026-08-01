import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAiEvent,
  createHistoryInput,
  createTurnState,
  type AiEvent,
} from './chatState.ts';

describe('AI chat turn state', () => {
  it('accumulates streamed assistant text for the active request only', () => {
    let state = createTurnState('turn-1');
    state = applyAiEvent(state, { requestId: 'other', type: 'assistant_delta', delta: 'ignored' });
    state = applyAiEvent(state, { requestId: 'turn-1', type: 'assistant_delta', delta: '正在' });
    state = applyAiEvent(state, { requestId: 'turn-1', type: 'assistant_delta', delta: '处理' });
    assert.equal(state.assistantText, '正在处理');
  });

  it('tracks tool progress, results, and generated artifacts', () => {
    let state = createTurnState('turn-1');
    const events: AiEvent[] = [
      {
        requestId: 'turn-1',
        type: 'tool_start',
        callId: 'call-1',
        toolId: 'edit.compress',
        toolName: { zh: '压缩', en: 'Compress' },
        inputFileNames: ['one.pdf'],
      },
      {
        requestId: 'turn-1',
        type: 'tool_progress',
        callId: 'call-1',
        toolId: 'edit.compress',
        fraction: 0.5,
      },
      {
        requestId: 'turn-1',
        type: 'tool_result',
        callId: 'call-1',
        toolId: 'edit.compress',
        ok: true,
        files: [{ id: 'file-2', name: 'one-compressed.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) }],
      },
    ];
    for (const event of events) state = applyAiEvent(state, event);

    assert.equal(state.tools[0]?.status, 'done');
    assert.equal(state.tools[0]?.fraction, 1);
    assert.equal(state.artifacts[0]?.name, 'one-compressed.pdf');
  });

  it('keeps a workflow preview and tool argument summary as a turn audit trail', () => {
    let state = createTurnState('turn-1');
    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'workflow_preview',
      steps: [
        {
          callId: 'pivot',
          toolId: 'office:excel:create:pivot',
          toolName: { zh: '创建数据透视表', en: 'Create pivot table' },
          details: '{"path":"销售.xlsx"}',
        },
      ],
    });
    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'tool_start',
      callId: 'pivot',
      toolId: 'office:excel:create:pivot',
      toolName: { zh: '创建数据透视表', en: 'Create pivot table' },
      inputFileNames: [],
      details: '{"path":"销售.xlsx"}',
    });

    assert.equal(state.workflow.length, 1);
    assert.equal(state.workflow[0]?.toolId, 'office:excel:create:pivot');
    assert.match(state.tools[0]?.details ?? '', /销售\.xlsx/);
  });

  it('creates a reusable history draft without tool arguments or artifact bytes', () => {
    let state = createTurnState('turn-1');
    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'workflow_preview',
      steps: [{
        callId: 'pivot',
        toolId: 'office:excel:create:pivot',
        toolName: { zh: '创建数据透视表', en: 'Create pivot table' },
        details: '{"api_key":"private-key"}',
      }],
    });
    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'tool_start',
      callId: 'pivot',
      toolId: 'office:excel:create:pivot',
      toolName: { zh: '创建数据透视表', en: 'Create pivot table' },
      inputFileNames: ['销售.xlsx'],
      details: '{"password":"private-password"}',
    });
    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'tool_result',
      callId: 'pivot',
      toolId: 'office:excel:create:pivot',
      ok: true,
      files: [],
    });

    const input = createHistoryInput({
      prompt: '按地区汇总销售额',
      response: '处理完成',
      success: true,
      turn: state,
      artifacts: [{
        name: '销售汇总.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: new Uint8Array([1, 2, 3]),
      }],
    });

    assert.deepEqual(input, {
      prompt: '按地区汇总销售额',
      response: '处理完成',
      success: true,
      workflow: [{
        toolId: 'office:excel:create:pivot',
        toolName: { zh: '创建数据透视表', en: 'Create pivot table' },
      }],
      tools: [{
        toolId: 'office:excel:create:pivot',
        toolName: { zh: '创建数据透视表', en: 'Create pivot table' },
        status: 'done',
      }],
      artifacts: [{ name: '销售汇总.xlsx' }],
    });
    assert.doesNotMatch(JSON.stringify(input), /private-key|private-password|bytes/);
  });

  it('adds and clears approval requests', () => {
    let state = createTurnState('turn-1');
    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'approval_required',
      approvalId: 'approval-1',
      toolId: 'edit.compress',
      toolName: { zh: '压缩', en: 'Compress' },
      inputFileNames: ['one.pdf'],
      details: '{"level":"balanced"}',
    });
    assert.equal(state.approvals.length, 1);
    assert.equal(state.approvals[0]?.details, '{"level":"balanced"}');

    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'approval_cleared',
      approvalId: 'approval-1',
    });
    assert.deepEqual(state.approvals, []);
  });

  it('marks a turn complete with the final provider message', () => {
    let state = createTurnState('turn-1');
    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'assistant_delta',
      delta: 'draft',
    });
    state = applyAiEvent(state, {
      requestId: 'turn-1',
      type: 'assistant_done',
      content: 'final',
    });
    assert.equal(state.assistantText, 'final');
  });
});
