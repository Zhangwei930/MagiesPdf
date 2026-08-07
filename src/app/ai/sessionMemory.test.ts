import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  emptySessionMemory,
  historyWithToolMemory,
  rememberNote,
  rememberToolResult,
  sessionMemoryLines,
} from './sessionMemory.ts';

describe('sessionMemory', () => {
  it('tracks written Office paths and keeps focus on the latest write', () => {
    let memory = emptySessionMemory();
    memory = rememberToolResult(memory, {
      toolId: 'office:excel:write',
      ok: true,
      result: { written: 'Magies Office Output/555.xlsx', cellsWritten: 40 },
    }, () => 1);
    memory = rememberToolResult(memory, {
      toolId: 'office:excel:format:range',
      ok: true,
      result: { written: 'Magies Office Output/555 (2).xlsx' },
    }, () => 2);

    assert.equal(memory.focusPath, 'Magies Office Output/555 (2).xlsx');
    assert.equal(memory.recentWrites.length, 2);
    assert.equal(memory.recentWrites[0]?.path, 'Magies Office Output/555.xlsx');
    assert.match(memory.recentTools[0]?.detail || '', /cellsWritten=40/);
  });

  it('records failures without moving focusPath', () => {
    let memory = emptySessionMemory();
    memory = rememberToolResult(memory, {
      toolId: 'office:excel:write',
      ok: true,
      result: { written: 'a.xlsx' },
    }, () => 1);
    memory = rememberToolResult(memory, {
      toolId: 'office:excel:write',
      ok: false,
      error: 'permission denied',
    }, () => 2);

    assert.equal(memory.focusPath, 'a.xlsx');
    assert.equal(memory.recentTools.at(-1)?.ok, false);
    assert.match(memory.recentTools.at(-1)?.detail || '', /permission denied/);
  });

  it('seeds focus from a successful read when nothing has been written', () => {
    const memory = rememberToolResult(emptySessionMemory(), {
      toolId: 'office:excel:read',
      ok: true,
      result: { path: 'sales/555.xlsx', cells: [] },
    }, () => 1);
    assert.equal(memory.focusPath, 'sales/555.xlsx');
  });

  it('summarizes memory for the system prompt', () => {
    let memory = emptySessionMemory();
    memory = rememberToolResult(memory, {
      toolId: 'office:excel:write',
      ok: true,
      result: { written: 'out/a.xlsx' },
    }, () => 1);
    memory = rememberNote(memory, 'User wants steel-blue headers');
    const lines = sessionMemoryLines(memory).join('\n');
    assert.match(lines, /Session focus document/);
    assert.match(lines, /out\/a\.xlsx/);
    assert.match(lines, /刚才那个|follow-up|继续改/);
    assert.match(lines, /steel-blue headers/);
  });

  it('annotates assistant history with tool trails', () => {
    const history = historyWithToolMemory([
      { role: 'user', content: '填数据' },
      {
        role: 'assistant',
        content: '写好了',
        tools: [{ toolId: 'office:excel:write', status: 'done' }],
        artifacts: [{ name: '555.xlsx' }],
      },
    ]);
    assert.equal(history[0]?.content, '填数据');
    assert.match(history[1]?.content || '', /写好了/);
    assert.match(history[1]?.content || '', /office:excel:write:done/);
    assert.match(history[1]?.content || '', /555\.xlsx/);
  });
});
