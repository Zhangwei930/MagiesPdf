const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  AgentRuntime,
  redactToolArguments,
  relativePathInWorkspace,
  systemPrompt,
  toolDetails,
} = require('./agentRuntime.cjs');

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
  it('computes a workspace-relative path and rejects escapes', () => {
    assert.equal(
      relativePathInWorkspace('/Users/x/Docs', '/Users/x/Docs/sales/555.xlsx'),
      'sales/555.xlsx',
    );
    assert.equal(relativePathInWorkspace('/Users/x/Docs', '/Users/x/Other/a.xlsx'), '');
    assert.equal(relativePathInWorkspace('', '/Users/x/Docs/a.xlsx'), '');
    assert.equal(relativePathInWorkspace('/Users/x/Docs', ''), '');
  });

  it('system prompt prefers Office automation tools and names the open document', () => {
    const prompt = systemPrompt('zh', [], 'confirm', {
      hasOfficeTools: true,
      workspacePath: '/Users/x/Docs',
      activeOffice: {
        name: '555.xlsx',
        path: '/Users/x/Docs/555.xlsx',
        relativePath: '555.xlsx',
        kind: 'sheet',
        dirty: false,
        inWorkspace: true,
        saved: true,
      },
    });

    assert.match(prompt, /Chinese/);
    assert.match(prompt, /555\.xlsx/);
    assert.match(prompt, /office_excel_/);
    assert.match(prompt, /relative path/i);
    assert.match(prompt, /\/Users\/x\/Docs/);
    assert.match(prompt, /Never claim Magies can only convert formats/i);
  });

  it('system prompt tells the model when the open Office file is unsaved or outside the workspace', () => {
    const unsaved = systemPrompt('en', [], 'confirm', {
      hasOfficeTools: true,
      workspacePath: '/w',
      activeOffice: {
        name: '未命名.xlsx',
        path: '',
        relativePath: '',
        kind: 'sheet',
        dirty: true,
        inWorkspace: false,
        saved: false,
      },
    });
    assert.match(unsaved, /not been saved|save first/i);

    const outside = systemPrompt('en', [], 'confirm', {
      hasOfficeTools: true,
      workspacePath: '/w',
      activeOffice: {
        name: 'out.xlsx',
        path: '/other/out.xlsx',
        relativePath: '',
        kind: 'sheet',
        dirty: false,
        inWorkspace: false,
        saved: true,
      },
    });
    assert.match(outside, /outside the granted workspace|not inside/i);
  });

  it('system prompt without Office tools does not invent Excel write APIs', () => {
    const prompt = systemPrompt('en', [], 'confirm', {
      hasOfficeTools: false,
      workspacePath: '',
      activeOffice: null,
    });
    assert.match(prompt, /grant|workspace|folder/i);
    assert.doesNotMatch(prompt, /Prefer office_excel_write/);
  });

  it('system prompt carries session memory across turns for follow-up edits', () => {
    const prompt = systemPrompt('zh', [], 'confirm', {
      hasOfficeTools: true,
      workspacePath: '/Users/x/Docs',
      activeOffice: {
        name: '555.xlsx',
        path: '/Users/x/Docs/555.xlsx',
        relativePath: '555.xlsx',
        kind: 'sheet',
        dirty: false,
        inWorkspace: true,
        saved: true,
      },
      sessionMemory: {
        focusPath: 'Magies Office Output/555.xlsx',
        recentWrites: [{
          path: 'Magies Office Output/555.xlsx',
          toolId: 'office:excel:write',
          at: 1,
        }],
        recentTools: [{
          toolId: 'office:excel:write',
          ok: true,
          detail: 'cellsWritten=40',
          at: 1,
        }],
        notes: [],
      },
    });
    assert.match(prompt, /Session focus document/);
    assert.match(prompt, /Magies Office Output\/555\.xlsx/);
    assert.match(prompt, /cellsWritten=40/);
    assert.match(prompt, /继续改|刚才那个|follow-up/i);
    assert.match(prompt, /Remember prior turns|follow-ups refer/i);
  });

  it('includes Office tool results on tool_result events so the UI can open written files', async () => {
    const events = [];
    let modelStep = 0;
    const runtime = new AgentRuntime({
      tools: [],
      model: {
        async streamMessage() {
          modelStep += 1;
          if (modelStep === 1) {
            return {
              content: '',
              tool_calls: [{
                id: 'w1',
                type: 'function',
                function: {
                  name: 'office_excel_write',
                  arguments: JSON.stringify({
                    path: '555.xlsx',
                    start_cell: 'A1',
                    values: [['Name', 'Amount'], ['A', 1]],
                  }),
                },
              }],
            };
          }
          return { content: '已写入。', tool_calls: [] };
        },
      },
      executeTool: async () => { throw new Error('catalog tools must not run'); },
      requestApproval: async () => true,
      officeToolProvider: {
        listTools: async () => [{
          functionName: 'office_excel_write',
          toolId: 'office:excel:write',
          name: { zh: '写入 Excel', en: 'Write Excel' },
          requiresApproval: true,
          providerTool: {
            type: 'function',
            function: { name: 'office_excel_write', description: 'Write Excel', parameters: { type: 'object' } },
          },
        }],
        callTool: async () => ({
          source: '555.xlsx',
          written: 'Magies Office Output/555.xlsx',
          cellsWritten: 4,
        }),
      },
    });

    await runtime.runTurn({
      prompt: '填数据',
      history: [],
      locale: 'zh',
      files: [],
      officeContext: {
        workspacePath: '/Users/x/Docs',
        activeOffice: {
          name: '555.xlsx',
          path: '/Users/x/Docs/555.xlsx',
          relativePath: '555.xlsx',
          kind: 'sheet',
          dirty: false,
          inWorkspace: true,
          saved: true,
        },
      },
      config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', maxSteps: 3 },
      onEvent: (event) => events.push(event),
    });

    const resultEvent = events.find((event) => event.type === 'tool_result' && event.ok);
    assert.equal(resultEvent.toolId, 'office:excel:write');
    assert.equal(resultEvent.result.written, 'Magies Office Output/555.xlsx');
  });

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

  it('denies writing tools outright in observer mode instead of asking', async () => {
    const approvals = [];
    const calls = [];
    const officeTool = {
      functionName: 'office_word_write',
      toolId: 'office:word:write',
      name: { zh: '写入', en: 'Write' },
      requiresApproval: true,
      providerTool: {
        type: 'function',
        function: { name: 'office_word_write', description: 'write', parameters: { type: 'object', properties: {} } },
      },
    };
    let modelStep = 0;

    const runtime = new AgentRuntime({
      tools: [],
      model: {
        async streamMessage() {
          modelStep += 1;
          return modelStep === 1
            ? {
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'office_word_write', arguments: '{}' } }],
              }
            : { content: '观察者模式下不能写。', tool_calls: [] };
        },
      },
      executeTool: async () => { throw new Error('local tools must not run'); },
      requestApproval: async (request) => {
        approvals.push(request.toolId);
        return true;
      },
      officeToolProvider: {
        listTools: async () => [officeTool],
        callTool: async (...args) => { calls.push(args); return 'ok'; },
      },
    });

    await runtime.runTurn({
      prompt: '改一下',
      history: [],
      locale: 'zh',
      files: [],
      config: {
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'local',
        maxSteps: 3,
        permissionMode: 'observer',
      },
      onEvent: () => {},
    });

    // Nobody is asked and nothing runs: observer mode is a refusal, not a prompt.
    assert.deepEqual(approvals, []);
    assert.deepEqual(calls, []);
  });

  it('runs without asking in auto permission mode, except where a tool demands a person', async () => {
    const approvals = [];
    const officeTool = {
      functionName: 'office_word_read',
      toolId: 'office:word:read',
      name: { zh: '读取', en: 'Read' },
      requiresApproval: true,
      providerTool: {
        type: 'function',
        function: { name: 'office_word_read', description: 'read', parameters: { type: 'object', properties: {} } },
      },
    };
    const macroTool = {
      functionName: 'office_macro_run',
      toolId: 'office:macro:run',
      name: { zh: '运行宏', en: 'Run macro' },
      requiresApproval: true,
      providerTool: {
        type: 'function',
        function: { name: 'office_macro_run', description: 'macro', parameters: { type: 'object', properties: {} } },
      },
    };
    let modelStep = 0;

    const runtime = new AgentRuntime({
      tools: [],
      model: {
        async streamMessage() {
          modelStep += 1;
          if (modelStep === 1) {
            return {
              content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'office_word_read', arguments: '{}' } }],
            };
          }
          if (modelStep === 2) {
            return {
              content: '',
              tool_calls: [{ id: 'c2', type: 'function', function: { name: 'office_macro_run', arguments: '{}' } }],
            };
          }
          return { content: '完成。', tool_calls: [] };
        },
      },
      executeTool: async () => { throw new Error('local tools must not run'); },
      requestApproval: async (request) => {
        approvals.push(request.toolId);
        return true;
      },
      officeToolProvider: {
        listTools: async () => [officeTool, macroTool],
        callTool: async () => 'ok',
      },
    });

    await runtime.runTurn({
      prompt: '读一下',
      history: [],
      locale: 'zh',
      files: [],
      config: {
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'local',
        maxSteps: 4,
        permissionMode: 'auto',
      },
      onEvent: () => {},
    });

    // The ordinary read went through unattended; running a macro is arbitrary
    // code and still stops for a person whatever the mode says.
    assert.deepEqual(approvals, ['office:macro:run']);
  });

  it('offers the web search tool and asks before the query leaves the machine', async () => {
    const { SEARCH_TOOL } = require('./webSearch.cjs');
    const approvals = [];
    const calls = [];
    let modelStep = 0;

    const runtime = new AgentRuntime({
      tools: [],
      model: {
        async streamMessage() {
          modelStep += 1;
          return modelStep === 1
            ? {
                content: '',
                tool_calls: [{
                  id: 'search-call',
                  type: 'function',
                  function: { name: 'web_search', arguments: '{"query":"pdf/a spec"}' },
                }],
              }
            : { content: '查到了。', tool_calls: [] };
        },
      },
      executeTool: async () => { throw new Error('local tools must not run'); },
      requestApproval: async (request) => {
        approvals.push(request);
        return true;
      },
      webSearchProvider: {
        listTools: async () => [{ ...SEARCH_TOOL }],
        async callTool(functionName, args) {
          calls.push({ functionName, args });
          return { query: args.query, results: [{ title: 'T', url: 'https://a', snippet: 'S' }] };
        },
      },
    });

    const result = await runtime.runTurn({
      prompt: '查一下 PDF/A 规范',
      history: [],
      locale: 'zh',
      files: [{ id: 'file-1', name: 'private.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2]) }],
      config: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'local', maxSteps: 3 },
      onEvent: () => {},
    });

    assert.equal(result.message, '查到了。');
    // The user sees the query before it is sent, and the open document is not
    // part of what goes out.
    assert.equal(approvals[0].toolId, 'web:search');
    assert.match(approvals[0].details, /pdf\/a spec/i);
    assert.deepEqual(calls, [{ functionName: 'web_search', args: { query: 'pdf/a spec' } }]);
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

/**
 * The worker pool transfers input buffers rather than copying them — a 200 MB
 * scan should not be duplicated on its way in. That contract is fine for a
 * caller that read the file for this one run, and wrong for the AI workspace,
 * which keeps its files for the whole turn: the transfer detached the
 * workspace's own array, so a second tool on the same file received zero bytes
 * and reported a damaged PDF.
 *
 * Measured before the fix: a three-byte input became `length: 0` the moment it
 * was dispatched.
 */
it('a workspace file survives being handed to a tool', async () => {
  const source = new Uint8Array([1, 2, 3]);
  let dispatched = null;
  let step = 0;

  const runtime = new AgentRuntime({
    tools: [{
      id: 'edit.compress',
      name: { zh: '压缩', en: 'Compress' },
      description: { zh: '', en: '' },
      input: { min: 1, max: 1, accept: ['application/pdf'] },
      params: [],
    }],
    model: {
      async streamMessage() {
        step += 1;
        if (step === 1) {
          return {
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'edit__compress',
                arguments: '{"input_file_ids":["file-1"]}',
              },
            }],
          };
        }
        return { content: 'done', tool_calls: [] };
      },
    },
    executeTool: async (request) => {
      dispatched = request.files[0].bytes;
      // Exactly what the worker pool does with the buffers it is given.
      structuredClone(dispatched.buffer, { transfer: [dispatched.buffer] });
      return { files: [], summary: { zh: '', en: '' } };
    },
    requestApproval: async () => true,
  });

  await runtime.runTurn({
    prompt: 'compress it',
    history: [],
    locale: 'en',
    files: [{ id: 'file-1', name: 'a.pdf', mime: 'application/pdf', bytes: source }],
    config: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'local', maxSteps: 4 },
    onEvent: () => {},
  });

  assert.ok(dispatched, 'the tool actually ran — otherwise this asserts nothing');
  assert.equal(dispatched.byteLength, 0, 'the pool detached what it was handed');
  assert.equal(source.byteLength, 3, 'the workspace still has its file for the next step');
  assert.deepEqual([...source], [1, 2, 3]);
});
