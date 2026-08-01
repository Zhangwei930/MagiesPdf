'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  createExternalMcpClientManager,
  externalFunctionName,
  normalizeMcpResult,
} = require('./clientManager.cjs');

function memorySecretStore(initial = '') {
  let value = initial;
  return {
    getMcpConfig: () => value,
    hasMcpConfig: () => value !== '',
    setMcpConfig: (next) => { value = next; },
  };
}

describe('external MCP client manager', () => {
  it('builds stable provider-safe names without collisions', () => {
    const first = externalFunctionName('notion workspace', 'search/pages');
    const second = externalFunctionName('notion workspace', 'search-pages');
    assert.match(first, /^[A-Za-z0-9_-]+$/);
    assert.ok(first.length <= 64);
    assert.notEqual(first, second);
    assert.equal(first, externalFunctionName('notion workspace', 'search/pages'));
  });

  it('connects enabled servers, follows tool pagination, and exposes redacted status', async () => {
    const secretStore = memorySecretStore(JSON.stringify({
      mcpServers: {
        notion: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer hidden' } },
        disabled: { command: 'never-run', disabled: true },
      },
    }));
    const listCalls = [];
    const manager = createExternalMcpClientManager({
      secretStore,
      connectServer: async (server) => {
        assert.equal(server.id, 'notion');
        return {
          async listTools(params) {
            listCalls.push(params);
            return params?.cursor
              ? {
                  tools: [{
                    name: 'create-page',
                    title: 'Create page',
                    description: 'Create a Notion page',
                    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
                  }],
                }
              : {
                  tools: [{
                    name: 'search',
                    description: 'Search Notion',
                    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                  }],
                  nextCursor: 'next',
                };
          },
          async close() {},
        };
      },
      version: '2.0.0',
    });

    const tools = await manager.listTools();

    assert.equal(tools.length, 2);
    assert.equal(tools[0].serverId, 'notion');
    assert.equal(tools[0].providerTool.function.parameters.type, 'object');
    assert.match(tools[0].providerTool.function.description, /notion/i);
    assert.deepEqual(listCalls, [undefined, { cursor: 'next' }]);
    assert.deepEqual(manager.getStatus(), {
      configured: true,
      servers: [
        { id: 'notion', transport: 'http', enabled: true, state: 'connected', toolCount: 2, error: '' },
        { id: 'disabled', transport: 'stdio', enabled: false, state: 'disabled', toolCount: 0, error: '' },
      ],
    });
    assert.equal(JSON.stringify(manager.getStatus()).includes('hidden'), false);
  });

  it('calls a discovered tool with cancellation and bounded normalized results', async () => {
    const controller = new AbortController();
    let callRequest;
    let callOptions;
    const manager = createExternalMcpClientManager({
      secretStore: memorySecretStore(JSON.stringify({ mcpServers: { mail: { command: 'mail-mcp' } } })),
      connectServer: async () => ({
        listTools: async () => ({
          tools: [{ name: 'find_messages', inputSchema: { type: 'object' } }],
        }),
        async callTool(request, _schema, options) {
          callRequest = request;
          callOptions = options;
          options.onprogress({ progress: 1, total: 2 });
          return {
            content: [
              { type: 'text', text: 'found one message' },
              { type: 'image', mimeType: 'image/png', data: 'very-large-base64' },
            ],
            structuredContent: { count: 1 },
          };
        },
        async close() {},
      }),
    });
    const [tool] = await manager.listTools();
    const progress = [];

    const result = await manager.callTool(tool.functionName, { query: 'invoice' }, {
      signal: controller.signal,
      onProgress: (fraction) => progress.push(fraction),
    });

    assert.deepEqual(callRequest, { name: 'find_messages', arguments: { query: 'invoice' } });
    assert.equal(callOptions.signal, controller.signal);
    assert.deepEqual(progress, [0.5]);
    assert.match(result, /found one message/);
    assert.match(result, /image\/png/);
    assert.doesNotMatch(result, /very-large-base64/);
    assert.match(result, /"count":1/);
  });

  it('isolates failed servers and closes live clients when configuration is cleared', async () => {
    const closed = [];
    const secretStore = memorySecretStore(JSON.stringify({
      mcpServers: {
        broken: { command: 'broken' },
        working: { command: 'working' },
      },
    }));
    const manager = createExternalMcpClientManager({
      secretStore,
      connectServer: async (server) => {
        if (server.id === 'broken') throw new Error('connection refused with token=secret');
        return {
          listTools: async () => ({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }),
          close: async () => { closed.push(server.id); },
        };
      },
    });

    assert.equal((await manager.listTools()).length, 1);
    const status = manager.getStatus();
    assert.equal(status.servers[0].state, 'error');
    assert.match(status.servers[0].error, /connection refused/);
    assert.doesNotMatch(status.servers[0].error, /secret/);

    await manager.clearConfig();
    assert.deepEqual(closed, ['working']);
    assert.deepEqual(manager.getStatus(), { configured: false, servers: [] });
  });

  it('finishes an in-flight refresh before replacing the configuration', async () => {
    const secretStore = memorySecretStore(JSON.stringify({
      mcpServers: { old: { command: 'old-mcp' } },
    }));
    const connected = [];
    let releaseOld;
    const oldReady = new Promise((resolve) => { releaseOld = resolve; });
    const manager = createExternalMcpClientManager({
      secretStore,
      connectServer: async (server) => {
        connected.push(server.id);
        if (server.id === 'old') await oldReady;
        return {
          listTools: async () => ({ tools: [] }),
          close: async () => {},
        };
      },
    });

    const firstRefresh = manager.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    const replacement = manager.setConfig(JSON.stringify({
      mcpServers: { next: { command: 'next-mcp' } },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(connected, ['old']);

    releaseOld();
    await firstRefresh;
    const status = await replacement;
    assert.deepEqual(connected, ['old', 'next']);
    assert.equal(status.servers[0].id, 'next');
  });

  it('discovers and calls a real stdio MCP server', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-external-mcp-'));
    const serverPath = path.join(directory, 'echo-server.cjs');
    fs.writeFileSync(serverPath, [
      `'use strict';`,
      `const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});`,
      `const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});`,
      `const { CallToolRequestSchema, ListToolsRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});`,
      `const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));`,
      `server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: 'text', text: request.params.arguments.text }] }));`,
      `server.connect(new StdioServerTransport()).catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });`,
      '',
    ].join('\n'));
    const manager = createExternalMcpClientManager({
      secretStore: memorySecretStore(JSON.stringify({
        mcpServers: { echo: { command: process.execPath, args: [serverPath] } },
      })),
    });

    try {
      const [tool] = await manager.listTools();
      assert.equal(tool.toolName, 'echo');
      assert.equal(await manager.callTool(tool.functionName, { text: 'hello MCP' }), 'hello MCP');
    } finally {
      await manager.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('aborts an in-flight connection when the manager closes', async () => {
    let connectionSignal;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const manager = createExternalMcpClientManager({
      secretStore: memorySecretStore(JSON.stringify({
        mcpServers: { waiting: { command: 'waiting-mcp' } },
      })),
      connectServer: async (_server, { signal }) => {
        connectionSignal = signal;
        markStarted();
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    });

    const refreshing = manager.refresh();
    await started;
    const closing = manager.close();
    assert.equal(connectionSignal.aborted, true);
    await refreshing;
    await closing;
  });
});

describe('external MCP result normalization', () => {
  it('truncates untrusted tool text before it reaches the model', () => {
    const result = normalizeMcpResult({ content: [{ type: 'text', text: 'x'.repeat(100) }] }, 32);
    assert.ok(result.length < 100);
    assert.match(result, /truncated/i);
  });
});
