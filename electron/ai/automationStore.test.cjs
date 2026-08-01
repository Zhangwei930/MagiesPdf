const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { createAutomationStore } = require('./automationStore.cjs');

async function storeFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-automation-'));
  let id = 0;
  let time = 100;
  const filePath = path.join(directory, 'ai-automations.json');
  return {
    filePath,
    store: createAutomationStore({
      filePath,
      createId: () => `id-${id += 1}`,
      now: () => time += 1,
      logger: { error() {} },
    }),
  };
}

describe('AI automation store', () => {
  it('persists normalized review and unattended rules without credentials', async () => {
    const { filePath, store } = await storeFixture();
    const review = store.createRule({
      name: '每日汇总',
      prompt: '生成日报 token=review-secret',
      mode: 'review',
      trigger: { type: 'daily', at: '09:30' },
      allowedToolIds: ['office:excel:read'],
      maxRunsPerDay: 3,
      retryLimit: 2,
    });
    const unattended = store.createRule({
      name: '新表格处理',
      prompt: '处理新文件 api_key=unattended-secret',
      mode: 'unattended',
      trigger: { type: 'folder', extensions: ['xlsx', '.PDF', '.xlsx'] },
      allowedToolIds: ['office:excel:read', 'office:excel:create:pivot'],
      maxRunsPerDay: 5,
      retryLimit: 1,
    });

    assert.equal(review.prompt, '生成日报 token=[redacted]');
    assert.deepEqual(review.allowedToolIds, []);
    assert.deepEqual(review.trigger, { type: 'daily', at: '09:30' });
    assert.equal(unattended.prompt, '处理新文件 api_key=[redacted]');
    assert.deepEqual(unattended.trigger, { type: 'folder', extensions: ['.pdf', '.xlsx'] });
    assert.deepEqual(unattended.allowedToolIds, [
      'office:excel:read',
      'office:excel:create:pivot',
    ]);
    assert.equal(unattended.enabled, true);
    assert.equal(unattended.failureCount, 0);

    const disk = await fs.readFile(filePath, 'utf8');
    assert.doesNotMatch(disk, /review-secret|unattended-secret/);
    const restored = createAutomationStore({ filePath, logger: { error() {} } });
    assert.deepEqual(restored.getState().rules, [unattended, review]);
  });

  it('validates unsafe rules and unattended allowlists', async () => {
    const { store } = await storeFixture();
    assert.throws(() => store.createRule({}), /name is required/);
    assert.throws(() => store.createRule({
      name: 'bad', prompt: 'task', mode: 'unattended',
      trigger: { type: 'daily', at: '25:00' }, allowedToolIds: ['office:excel:read'],
    }), /HH:MM/);
    assert.throws(() => store.createRule({
      name: 'bad', prompt: 'task', mode: 'unattended',
      trigger: { type: 'folder', extensions: ['.exe'] }, allowedToolIds: ['office:excel:read'],
    }), /supported document extension/);
    assert.throws(() => store.createRule({
      name: 'bad', prompt: 'task', mode: 'unattended',
      trigger: { type: 'daily', at: '10:00' }, allowedToolIds: [],
    }), /allowed Office tool/);
    assert.throws(() => store.createRule({
      name: 'bad', prompt: 'task', mode: 'unattended',
      trigger: { type: 'daily', at: '10:00' }, allowedToolIds: ['external:danger'],
    }), /office:/);
  });

  it('tracks pending review tasks, daily limits, retries, pause, resume, and deletion', async () => {
    const { store } = await storeFixture();
    const rule = store.createRule({
      name: '审核任务',
      prompt: '处理文件',
      mode: 'review',
      trigger: { type: 'folder', extensions: ['.xlsx'] },
      maxRunsPerDay: 1,
      retryLimit: 1,
    });
    assert.equal(store.canTrigger(rule.id, '2026-08-01'), true);
    store.recordTrigger(rule.id, '2026-08-01');
    assert.equal(store.canTrigger(rule.id, '2026-08-01'), false);
    assert.equal(store.canTrigger(rule.id, '2026-08-02'), true);

    const pending = store.enqueue(rule.id, {
      prompt: '处理文件\n\n[Triggered file]\n销售.xlsx',
      sourcePath: '销售.xlsx',
    });
    assert.equal(store.getState().pending.length, 1);
    assert.equal(store.resolvePending(pending.id), true);
    assert.equal(store.resolvePending(pending.id), false);

    store.recordResult(rule.id, { success: false, error: 'token=runtime-secret', pause: true });
    let current = store.getState().rules[0];
    assert.equal(current.enabled, false);
    assert.equal(current.failureCount, 1);
    assert.equal(current.lastError, 'token=[redacted]');
    store.setRuleEnabled(rule.id, true);
    current = store.getState().rules[0];
    assert.equal(current.enabled, true);
    assert.equal(current.failureCount, 0);
    store.recordResult(rule.id, { success: true });
    store.addRun({ ruleId: rule.id, status: 'success', attempts: 1, message: '完成' });
    assert.equal(store.getState().runs.length, 1);
    assert.equal(store.deleteRule(rule.id), true);
    assert.equal(store.deleteRule(rule.id), false);
    assert.deepEqual(store.getState().rules, []);
  });
});
