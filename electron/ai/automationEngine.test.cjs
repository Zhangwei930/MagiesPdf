const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { createAutomationEngine } = require('./automationEngine.cjs');
const { createAutomationStore } = require('./automationStore.cjs');

async function fixture(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-engine-'));
  let id = 0;
  const store = createAutomationStore({
    filePath: path.join(directory, 'rules.json'),
    createId: () => `id-${id += 1}`,
    now: () => 100 + id,
    logger: { error() {} },
  });
  let documents = [];
  const calls = [];
  const events = [];
  const officeProvider = {
    getWorkspaceStatus: () => ({ configured: true, path: directory }),
    callTool: async () => ({ documents, truncated: false }),
  };
  const aiService = {
    runUnattended: async (request, onEvent) => {
      calls.push(request);
      onEvent({ type: 'tool_result', toolId: request.allowedToolIds[0], ok: true });
      return { message: '完成', files: [] };
    },
  };
  const now = new Date(2026, 7, 1, 10, 30, 0, 0).getTime();
  const engine = createAutomationEngine({
    store,
    officeProvider,
    aiService,
    emit: (event) => events.push(event),
    now: () => now,
    ...overrides,
  });
  return {
    aiService,
    calls,
    engine,
    events,
    officeProvider,
    setDocuments: (next) => { documents = next; },
    store,
  };
}

describe('AI automation engine', () => {
  it('queues one daily review task and does not duplicate it on later polls', async () => {
    const { engine, events, store } = await fixture();
    store.createRule({
      name: '日报审核', prompt: '生成日报', mode: 'review',
      trigger: { type: 'daily', at: '10:00' }, maxRunsPerDay: 2,
    });

    await engine.poll();
    await engine.poll();

    const state = store.getState();
    assert.equal(state.pending.length, 1);
    assert.equal(state.runs.length, 1);
    assert.equal(state.runs[0].status, 'queued');
    assert.equal(events.filter((event) => event.type === 'pending').length, 1);
  });

  it('runs an unattended daily rule with only its explicit Office allowlist', async () => {
    const { calls, engine, store } = await fixture();
    const rule = store.createRule({
      name: '自动日报', prompt: '自动生成日报', mode: 'unattended',
      trigger: { type: 'daily', at: '10:00' },
      allowedToolIds: ['office:excel:read', 'office:excel:create:chart'],
      maxRunsPerDay: 2,
      retryLimit: 1,
    });

    await engine.poll();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].allowedToolIds, rule.allowedToolIds);
    assert.equal(store.getState().runs[0].status, 'success');
    assert.equal(store.getState().rules[0].enabled, true);
  });

  it('baselines a workspace then queues only new matching files outside output folders', async () => {
    const { engine, setDocuments, store } = await fixture();
    store.createRule({
      name: '新表格审核', prompt: '处理新表格', mode: 'review',
      trigger: { type: 'folder', extensions: ['.xlsx'] }, maxRunsPerDay: 5,
    });
    setDocuments([{ path: '已有.xlsx', extension: '.xlsx' }]);
    await engine.poll();
    assert.equal(store.getState().pending.length, 0);

    setDocuments([
      { path: '已有.xlsx', extension: '.xlsx' },
      { path: '销售/新增.xlsx', extension: '.xlsx' },
      { path: 'Magies Office Output/输出.xlsx', extension: '.xlsx' },
      { path: '说明.docx', extension: '.docx' },
    ]);
    await engine.poll();

    const pending = store.getState().pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sourcePath, '销售/新增.xlsx');
    assert.match(pending[0].prompt, /销售\/新增\.xlsx/);
  });

  /**
   * The daily limit is meant to pace a rule, not to lose files. The baseline
   * of "what was already there" was advanced over everything present *before*
   * the files were dealt with, so anything past the day's limit stopped being
   * a new file — it was never picked up, that day or any other.
   */
  it('picks up tomorrow what the day\'s limit left over', async () => {
    let clock = new Date(2026, 7, 1, 10, 30, 0, 0).getTime();
    const { engine, setDocuments, store } = await fixture({ now: () => clock });
    store.createRule({
      name: '批量审核', prompt: '处理', mode: 'review',
      trigger: { type: 'folder', extensions: ['.xlsx'] }, maxRunsPerDay: 2,
    });
    setDocuments([]);
    await engine.poll();

    setDocuments([
      { path: 'a.xlsx', extension: '.xlsx' },
      { path: 'b.xlsx', extension: '.xlsx' },
      { path: 'c.xlsx', extension: '.xlsx' },
      { path: 'd.xlsx', extension: '.xlsx' },
    ]);
    await engine.poll();

    assert.deepEqual(
      store.getState().pending.map((entry) => entry.sourcePath).sort(),
      ['a.xlsx', 'b.xlsx'],
      'the day\'s limit is two',
    );

    // A new day: the limit resets, and what it held back is still waiting.
    clock = new Date(2026, 7, 2, 10, 30, 0, 0).getTime();
    await engine.poll();

    assert.deepEqual(
      store.getState().pending.map((entry) => entry.sourcePath).sort(),
      ['a.xlsx', 'b.xlsx', 'c.xlsx', 'd.xlsx'],
      'the two the limit held back must still arrive',
    );
  });

  it('does not offer the same file twice once it has been dealt with', async () => {
    const { engine, setDocuments, store } = await fixture();
    store.createRule({
      name: '批量审核', prompt: '处理', mode: 'review',
      trigger: { type: 'folder', extensions: ['.xlsx'] }, maxRunsPerDay: 5,
    });
    setDocuments([]);
    await engine.poll();

    setDocuments([{ path: 'a.xlsx', extension: '.xlsx' }]);
    await engine.poll();
    await engine.poll();

    assert.equal(store.getState().pending.length, 1);
  });

  it('retries pre-tool failures but pauses without retrying after a tool succeeds', async () => {
    let attempts = 0;
    const first = await fixture({
      aiService: {
        runUnattended: async (_request, onEvent) => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary model failure');
          onEvent({ type: 'tool_result', toolId: 'office:excel:read', ok: true });
          return { message: '完成', files: [] };
        },
      },
    });
    first.store.createRule({
      name: '可重试', prompt: '执行', mode: 'unattended',
      trigger: { type: 'daily', at: '10:00' },
      allowedToolIds: ['office:excel:read'], retryLimit: 1,
    });
    await first.engine.poll();
    assert.equal(attempts, 2);
    assert.equal(first.store.getState().runs[0].status, 'success');

    let mutatedAttempts = 0;
    const second = await fixture({
      aiService: {
        runUnattended: async (_request, onEvent) => {
          mutatedAttempts += 1;
          onEvent({ type: 'tool_result', toolId: 'office:excel:write', ok: true });
          throw new Error('failed after write');
        },
      },
    });
    second.store.createRule({
      name: '写后失败', prompt: '执行', mode: 'unattended',
      trigger: { type: 'daily', at: '10:00' },
      allowedToolIds: ['office:excel:write'], retryLimit: 2,
    });
    await second.engine.poll();
    assert.equal(mutatedAttempts, 1);
    assert.equal(second.store.getState().runs[0].status, 'error');
    assert.equal(second.store.getState().rules[0].enabled, false);
  });

  it('stays idle when the workspace is unavailable for unattended work', async () => {
    const { calls, engine, officeProvider, store } = await fixture();
    officeProvider.getWorkspaceStatus = () => ({ configured: false, path: '' });
    store.createRule({
      name: '等待授权', prompt: '执行', mode: 'unattended',
      trigger: { type: 'daily', at: '10:00' },
      allowedToolIds: ['office:excel:read'],
    });
    await engine.poll();
    assert.equal(calls.length, 0);
    assert.equal(store.getState().rules[0].lastDailyDate, '');
  });

  it('starts one polling timer and stops it cleanly', async () => {
    const scheduled = [];
    const cleared = [];
    const { engine } = await fixture({
      setIntervalFn: (callback, milliseconds) => {
        scheduled.push({ callback, milliseconds });
        return 42;
      },
      clearIntervalFn: (timer) => cleared.push(timer),
      pollMs: 12_345,
    });
    engine.start();
    engine.start();
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].milliseconds, 12_345);
    engine.stop();
    engine.stop();
    assert.deepEqual(cleared, [42]);
  });
});
