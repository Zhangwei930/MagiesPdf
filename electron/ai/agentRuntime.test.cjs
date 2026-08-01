const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { AgentRuntime, redactToolArguments, toolDetails } = require('./agentRuntime.cjs');

const tools = [
  {
    id: 'convert.pdf-to-text',
    category: 'convert',
    name: { zh: '提取文字', en: 'Extract text' },
    description: { zh: '提取 PDF 文字', en: 'Extract PDF text' },
    input: { accept: ['.pdf'], min: 1, max: 1 },
    output: 'single',
    runtime: 'worker',
    params: [],
  },
  {
    id: 'edit.get-info',
    category: 'edit',
    name: { zh: '文档信息', en: 'Document info' },
    description: { zh: '读取信息', en: 'Read metadata' },
    input: { accept: ['.pdf'], min: 1, max: 1 },
    output: 'report',
    runtime: 'worker',
    params: [],
  },
];

describe('Agent runtime', () => {
  it('redacts nested secrets and bounds retained argument details', () => {
    assert.deepEqual(redactToolArguments({
      path: '销售.xlsx',
      password: 'hidden',
      nested: [{ api_key: 'hidden-too', value: 3 }, 'plain'],
      accessToken: 'also-hidden',
    }), {
      path: '销售.xlsx',
      password: '[redacted]',
      nested: [{ api_key: '[redacted]', value: 3 }, 'plain'],
      accessToken: '[redacted]',
    });
    assert.equal(toolDetails({ text: 'x'.repeat(5000) }).length, 4000);
  });

  it('runs a tool loop, keeps bytes local, and returns output artifacts', async () => {
    const calls = [];
    const events = [];
    let modelStep = 0;
    const runtime = new AgentRuntime({
      tools,
      model: {
        async streamMessage(request) {
          calls.push(request);
          modelStep += 1;
          if (modelStep === 1) {
            return {
              content: '',
              tool_calls: [{
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'convert__pdf-to-text',
                  arguments: '{"input_file_ids":["file-1"]}',
                },
              }],
            };
          }
          return { content: '合同共两页，金额为 100 元。', tool_calls: [] };
        },
      },
      executeTool: async (request) => {
        assert.equal(request.toolId, 'convert.pdf-to-text');
        assert.deepEqual([...request.files[0].bytes], [1, 2, 3]);
        assert.equal(request.params.password, 'local-password');
        return {
          files: [{ name: 'contract.txt', mime: 'text/plain', bytes: new TextEncoder().encode('金额：100元') }],
          summary: { zh: '已提取', en: 'Extracted' },
        };
      },
      requestApproval: async () => true,
    });

    const result = await runtime.runTurn({
      prompt: '总结合同',
      history: [],
      locale: 'zh',
      files: [{ id: 'file-1', name: 'contract.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]), password: 'local-password' }],
      config: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'local', maxSteps: 4 },
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.message, '合同共两页，金额为 100 元。');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, 'contract.txt');
    assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(calls).includes('local-password'), false);
    assert.match(calls[1].messages.at(-1).content, /金额：100元/);
    assert.ok(events.some((event) => event.type === 'tool_start'));
    assert.ok(events.some((event) => event.type === 'tool_result'));
  });

  it('runs report tools without approval and reports denied write tools back to the model', async () => {
    const approvals = [];
    const executed = [];
    let step = 0;
    const runtime = new AgentRuntime({
      tools,
      model: {
        async streamMessage() {
          step += 1;
          if (step === 1) {
            return {
              content: '',
              tool_calls: [
                { id: 'read', type: 'function', function: { name: 'edit__get-info', arguments: '{"input_file_ids":["file-1"]}' } },
                { id: 'write', type: 'function', function: { name: 'convert__pdf-to-text', arguments: '{"input_file_ids":["file-1"]}' } },
              ],
            };
          }
          return { content: '已取消转换。', tool_calls: [] };
        },
      },
      executeTool: async ({ toolId }) => {
        executed.push(toolId);
        return { files: [], data: { pages: 2 } };
      },
      requestApproval: async ({ toolId }) => {
        approvals.push(toolId);
        return false;
      },
    });

    await runtime.runTurn({
      prompt: '查看并转换',
      history: [],
      locale: 'zh',
      files: [{ id: 'file-1', name: 'one.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) }],
      config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', maxSteps: 3 },
      onEvent: () => {},
    });

    assert.deepEqual(approvals, ['convert.pdf-to-text']);
    assert.deepEqual(executed, ['edit.get-info']);
  });

  it('fails with a typed error when the model exceeds the step budget', async () => {
    const runtime = new AgentRuntime({
      tools,
      model: {
        async streamMessage() {
          return {
            content: '',
            tool_calls: [{ id: 'read', type: 'function', function: { name: 'edit__get-info', arguments: '{"input_file_ids":["file-1"]}' } }],
          };
        },
      },
      executeTool: async () => ({ files: [], data: {} }),
      requestApproval: async () => true,
    });

    await assert.rejects(
      runtime.runTurn({
        prompt: '一直查看',
        history: [],
        locale: 'zh',
        files: [{ id: 'file-1', name: 'one.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) }],
        config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', maxSteps: 2 },
        onEvent: () => {},
      }),
      (error) => error.code === 'AI_STEP_LIMIT',
    );
  });

  it('discovers and approves external MCP tools without exposing document bytes', async () => {
    const approvals = [];
    const calls = [];
    let modelStep = 0;
    const externalTool = {
      functionName: 'mcp_notion_search_abcd1234',
      serverId: 'notion',
      toolName: 'search',
      toolId: 'mcp:notion:search',
      name: { zh: 'notion · 搜索', en: 'notion · Search' },
      providerTool: {
        type: 'function',
        function: {
          name: 'mcp_notion_search_abcd1234',
          description: '[External MCP: notion] Search pages',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    };
    const runtime = new AgentRuntime({
      tools,
      model: {
        async streamMessage(request) {
          modelStep += 1;
          assert.ok(request.tools.some((tool) => tool.function.name === externalTool.functionName));
          assert.match(request.messages[0].content, /untrusted/i);
          return modelStep === 1
            ? {
                content: '',
                tool_calls: [{
                  id: 'external-call',
                  type: 'function',
                  function: { name: externalTool.functionName, arguments: '{"query":"budget"}' },
                }],
              }
            : { content: '找到预算页面。', tool_calls: [] };
        },
      },
      executeTool: async () => { throw new Error('local tools must not run'); },
      requestApproval: async (request) => {
        approvals.push(request);
        return true;
      },
      externalToolProvider: {
        listTools: async () => [externalTool],
        async callTool(functionName, args, options) {
          calls.push({ functionName, args, signal: options.signal });
          options.onProgress(0.5);
          return 'Untrusted Notion result: Budget 2026';
        },
      },
    });
    const controller = new AbortController();

    const result = await runtime.runTurn({
      prompt: '在 Notion 查找预算',
      history: [],
      locale: 'zh',
      files: [{ id: 'file-1', name: 'private.pdf', mime: 'application/pdf', bytes: new Uint8Array([7, 8, 9]) }],
      config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', maxSteps: 3 },
      signal: controller.signal,
      onEvent: () => {},
    });

    assert.equal(result.message, '找到预算页面。');
    assert.equal(approvals[0].toolId, 'mcp:notion:search');
    assert.match(approvals[0].details, /"query": "budget"/);
    assert.deepEqual(calls, [{
      functionName: externalTool.functionName,
      args: { query: 'budget' },
      signal: controller.signal,
    }]);
    assert.equal(JSON.stringify(calls).includes('private.pdf'), false);
  });

  it('discovers approved local Office tools and treats document contents as untrusted data', async () => {
    const approvals = [];
    const providerCalls = [];
    const modelCalls = [];
    let modelStep = 0;
    const officeTool = {
      functionName: 'office_word_read',
      toolId: 'office:word:read',
      name: { zh: '读取 Word 内容', en: 'Read Word content' },
      requiresApproval: true,
      providerTool: {
        type: 'function',
        function: {
          name: 'office_word_read',
          description: 'Read a Word document in the granted workspace.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    };
    const runtime = new AgentRuntime({
      tools,
      model: {
        async streamMessage(request) {
          modelCalls.push(request);
          modelStep += 1;
          assert.ok(request.tools.some((candidate) => candidate.function.name === 'office_word_read'));
          return modelStep === 1
            ? {
                content: '',
                tool_calls: [{
                  id: 'office-call',
                  type: 'function',
                  function: { name: 'office_word_read', arguments: '{"path":"Contracts/A.docx"}' },
                }],
              }
            : { content: '合同内容已读取。', tool_calls: [] };
        },
      },
      executeTool: async () => { throw new Error('catalog tools must not run'); },
      requestApproval: async (request) => {
        approvals.push(request);
        return true;
      },
      officeToolProvider: {
        listTools: async () => [officeTool],
        async callTool(functionName, args, options) {
          providerCalls.push({ functionName, args, signal: options.signal });
          options.onProgress(1);
          return { path: 'Contracts/A.docx', text: '合同正文' };
        },
      },
    });
    const controller = new AbortController();

    const result = await runtime.runTurn({
      prompt: '读取合同',
      history: [],
      locale: 'zh',
      files: [],
      config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', maxSteps: 3 },
      signal: controller.signal,
      onEvent: () => {},
    });

    assert.equal(result.message, '合同内容已读取。');
    assert.equal(approvals[0].toolId, 'office:word:read');
    assert.match(approvals[0].details, /Contracts\/A\.docx/);
    assert.deepEqual(providerCalls, [{
      functionName: 'office_word_read',
      args: { path: 'Contracts/A.docx' },
      signal: controller.signal,
    }]);
    const toolMessage = modelCalls[1].messages.at(-1).content;
    assert.match(toolMessage, /"source":"local_office"/);
    assert.match(toolMessage, /"untrusted":true/);
  });

  it('previews multi-step Office workflows and retains sanitized tool details for audit', async () => {
    const events = [];
    const approvals = [];
    const officeTools = [
      {
        functionName: 'office_excel_read',
        toolId: 'office:excel:read',
        name: { zh: '读取 Excel 区域', en: 'Read Excel range' },
      },
      {
        functionName: 'office_excel_create_pivot',
        toolId: 'office:excel:create:pivot',
        name: { zh: '创建 Excel 数据透视表', en: 'Create Excel pivot table' },
      },
    ].map((tool) => ({
      ...tool,
      requiresApproval: true,
      providerTool: {
        type: 'function',
        function: {
          name: tool.functionName,
          description: tool.name.en,
          parameters: { type: 'object', properties: {} },
        },
      },
    }));
    let modelStep = 0;
    const runtime = new AgentRuntime({
      tools,
      model: {
        async streamMessage() {
          modelStep += 1;
          return modelStep === 1
            ? {
                content: '',
                tool_calls: [
                  {
                    id: 'read',
                    type: 'function',
                    function: {
                      name: 'office_excel_read',
                      arguments: '{"path":"销售.xlsx","range":"A1:C20"}',
                    },
                  },
                  {
                    id: 'pivot',
                    type: 'function',
                    function: {
                      name: 'office_excel_create_pivot',
                      arguments: '{"path":"销售.xlsx","row_field":"地区","data_field":"销售额","api_key":"private-key"}',
                    },
                  },
                ],
              }
            : { content: '数据透视表已创建。', tool_calls: [] };
        },
      },
      executeTool: async () => { throw new Error('catalog tools must not run'); },
      requestApproval: async (request) => {
        approvals.push(request.toolId);
        return true;
      },
      officeToolProvider: {
        listTools: async () => officeTools,
        callTool: async (functionName) => ({ functionName }),
      },
    });

    await runtime.runTurn({
      prompt: '按地区汇总销售额',
      history: [],
      locale: 'zh',
      files: [],
      config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', maxSteps: 3 },
      onEvent: (event) => events.push(event),
    });

    const previewIndex = events.findIndex((event) => event.type === 'workflow_preview');
    const firstToolIndex = events.findIndex((event) => event.type === 'tool_start');
    assert.ok(previewIndex >= 0 && previewIndex < firstToolIndex);
    assert.equal(events[previewIndex].steps.length, 2);
    assert.equal(events[previewIndex].steps[1].toolId, 'office:excel:create:pivot');
    assert.match(events[previewIndex].steps[1].details, /销售额/);
    assert.doesNotMatch(events[previewIndex].steps[1].details, /private-key/);
    assert.match(events[previewIndex].steps[1].details, /\[redacted\]/);
    assert.match(events[firstToolIndex].details, /销售\.xlsx/);
    assert.deepEqual(approvals, ['office:excel:read', 'office:excel:create:pivot']);
  });

  it('previews malformed and unknown workflow steps before reporting their errors', async () => {
    const events = [];
    let modelStep = 0;
    const runtime = new AgentRuntime({
      tools,
      model: {
        async streamMessage() {
          modelStep += 1;
          return modelStep === 1
            ? {
                content: '',
                tool_calls: [
                  { type: 'function', function: { name: 'unknown_one', arguments: '{' } },
                  { id: 'unknown', type: 'function', function: { name: 'unknown_two', arguments: '{}' } },
                ],
              }
            : { content: '无法执行未知步骤。', tool_calls: [] };
        },
      },
      executeTool: async () => { throw new Error('unknown tools must not run'); },
      requestApproval: async () => { throw new Error('unknown tools must not request approval'); },
    });

    await runtime.runTurn({
      prompt: '执行未知流程',
      history: [],
      locale: 'zh',
      files: [],
      config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', maxSteps: 3 },
      onEvent: (event) => events.push(event),
    });

    const preview = events.find((event) => event.type === 'workflow_preview');
    assert.equal(preview.steps[0].callId, '');
    assert.equal(preview.steps[0].toolId, 'unknown_one');
    assert.equal(preview.steps[0].details, 'Invalid tool arguments');
    assert.equal(events.filter((event) => event.type === 'tool_result' && !event.ok).length, 2);
  });
});
