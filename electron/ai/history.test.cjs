const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  MAX_AI_HISTORY_ENTRIES,
  createAiHistoryStore,
} = require('./history.cjs');

async function temporaryHistoryPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-ai-history-'));
  return path.join(directory, 'ai-history.json');
}

describe('AI task history store', () => {
  it('persists only bounded, allow-listed task metadata and restores Chinese records', async () => {
    const filePath = await temporaryHistoryPath();
    const store = createAiHistoryStore({
      filePath,
      now: () => 1_700_000_000_000,
      createId: () => 'history-1',
      logger: { error() {} },
    });

    const entry = store.append({
      prompt: '按地区汇总销售额',
      response: '已创建数据透视表',
      success: true,
      workflow: [{
        toolId: 'office:excel:create:pivot',
        toolName: { zh: '创建数据透视表', en: 'Create pivot table' },
        details: '{"api_key":"private-key"}',
      }],
      tools: [{
        toolId: 'office:excel:create:pivot',
        toolName: { zh: '创建数据透视表', en: 'Create pivot table' },
        status: 'done',
        details: '{"password":"private-password"}',
      }],
      artifacts: [{
        name: '销售汇总.xlsx',
        path: '/private/customer/销售汇总.xlsx',
        bytes: new Uint8Array([1, 2, 3]),
      }],
      apiKey: 'private-top-level-key',
    });

    assert.deepEqual(entry, {
      id: 'history-1',
      createdAt: 1_700_000_000_000,
      prompt: '按地区汇总销售额',
      response: '已创建数据透视表',
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

    const persisted = await fs.readFile(filePath, 'utf8');
    assert.doesNotMatch(persisted, /private-key|private-password|private-top-level-key/);
    assert.doesNotMatch(persisted, /details|bytes|\/private\/customer/);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
    }

    const restored = createAiHistoryStore({ filePath, logger: { error() {} } });
    assert.deepEqual(restored.list(), [entry]);
  });

  it('keeps newest entries first and evicts records beyond the fixed limit', async () => {
    const filePath = await temporaryHistoryPath();
    let nextId = 0;
    const store = createAiHistoryStore({
      filePath,
      now: () => nextId,
      createId: () => `history-${nextId += 1}`,
      logger: { error() {} },
    });

    for (let index = 0; index < MAX_AI_HISTORY_ENTRIES + 3; index += 1) {
      store.append({ prompt: `任务 ${index}`, response: '', success: true });
    }

    const entries = store.list();
    assert.equal(entries.length, MAX_AI_HISTORY_ENTRIES);
    assert.equal(entries[0].prompt, `任务 ${MAX_AI_HISTORY_ENTRIES + 2}`);
    assert.equal(entries.at(-1).prompt, '任务 3');
  });

  it('recovers from malformed files, rejects empty tasks, and can clear history', async () => {
    const filePath = await temporaryHistoryPath();
    await fs.writeFile(filePath, '{not-json', 'utf8');
    const errors = [];
    const store = createAiHistoryStore({
      filePath,
      createId: () => 'history-1',
      now: () => 10,
      logger: { error: (message) => errors.push(message) },
    });

    assert.deepEqual(store.list(), []);
    assert.equal(errors.length, 1);
    assert.throws(() => store.append({ prompt: '   ' }), /prompt is required/);
    store.append({ prompt: ` ${'x'.repeat(5000)} `, response: 'y'.repeat(5000) });
    assert.equal(store.list()[0].prompt.length, 4000);
    assert.equal(store.list()[0].response.length, 4000);
    assert.equal(store.clear(), true);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')), {
      version: 1,
      entries: [],
    });
  });

  it('removes one task without touching the rest', async () => {
    const filePath = await temporaryHistoryPath();
    let id = 0;
    const store = createAiHistoryStore({
      filePath,
      createId: () => `history-${(id += 1)}`,
      now: () => id,
    });
    store.append({ prompt: 'first' });
    store.append({ prompt: 'second' });
    store.append({ prompt: 'third' });

    assert.equal(store.remove('history-2'), true);
    assert.deepEqual(store.list().map((entry) => entry.prompt), ['third', 'first']);
    // Persisted, not only dropped from the cache.
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.deepEqual(saved.entries.map((entry) => entry.id), ['history-3', 'history-1']);

    // An id that is not there is a no-op, not a thrown error or a wipe.
    assert.equal(store.remove('history-2'), false);
    assert.equal(store.remove(''), false);
    assert.equal(store.list().length, 2);
  });

  it('filters malformed stored entries and unknown nested metadata', async () => {
    const filePath = await temporaryHistoryPath();
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      entries: [
        { id: '', createdAt: 1, prompt: 'missing id' },
        { id: 'bad-time', createdAt: 'not-a-number', prompt: 'bad time' },
        { id: 'empty-prompt', createdAt: 2, prompt: '   ' },
        {
          id: 'kept',
          createdAt: 3,
          prompt: ' 保留任务 ',
          workflow: [null, { toolId: '' }, { toolId: 'tool.one', toolName: {} }],
          tools: [{ toolId: '' }, { toolId: 'tool.one', status: 'running' }],
          artifacts: [{}, { name: ' 结果.pdf ' }],
        },
      ],
    }), 'utf8');

    const store = createAiHistoryStore({ filePath, logger: { error() {} } });
    assert.deepEqual(store.list(), [{
      id: 'kept',
      createdAt: 3,
      prompt: '保留任务',
      response: '',
      success: false,
      workflow: [{ toolId: 'tool.one' }],
      tools: [{ toolId: 'tool.one', status: 'error' }],
      artifacts: [{ name: '结果.pdf' }],
    }]);
  });

  it('redacts labelled credentials from persisted prompts and responses', async () => {
    const filePath = await temporaryHistoryPath();
    const store = createAiHistoryStore({
      filePath,
      createId: () => 'history-1',
      now: () => 1,
      logger: { error() {} },
    });

    const entry = store.append({
      prompt: '使用 api_key=prompt-secret 和 密码: chinese-secret 处理文件',
      response: 'Authorization: Bearer bearer-secret; token="response-secret"',
      success: true,
    });

    assert.match(entry.prompt, /api_key=\[redacted\]/);
    assert.match(entry.prompt, /密码: \[redacted\]/);
    assert.match(entry.response, /Bearer \[redacted\]/);
    assert.match(entry.response, /token=\[redacted\]/);
    const persisted = await fs.readFile(filePath, 'utf8');
    assert.doesNotMatch(
      persisted,
      /prompt-secret|chinese-secret|bearer-secret|response-secret/,
    );
  });

  it('fails loudly without changing memory when the atomic write cannot complete', async () => {
    assert.throws(() => createAiHistoryStore({ filePath: '' }), /file path is required/);
    const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'magies-ai-history-dir-'));
    const store = createAiHistoryStore({
      filePath: directoryPath,
      createId: () => 'history-1',
      now: () => 1,
      logger: { error() {} },
    });

    assert.throws(() => store.append({ prompt: '不能写入' }));
    assert.deepEqual(store.list(), []);
  });
});
