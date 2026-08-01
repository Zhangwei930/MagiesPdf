const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const { createMcpServer } = require('./serverFactory.cjs');

const tool = {
  id: 'edit.get-info',
  category: 'edit',
  name: { zh: '信息', en: 'Document info' },
  description: { zh: '读取信息', en: 'Read document metadata' },
  input: { accept: ['.pdf'], min: 1, max: 1 },
  output: 'report',
  runtime: 'worker',
  params: [],
};

describe('MCP protocol server', () => {
  it('lists and calls catalogue-backed tools over MCP', async () => {
    const calls = [];
    const server = createMcpServer({
      catalog: [tool],
      callTool: async (selected, args) => {
        calls.push([selected.id, args]);
        return { toolId: selected.id, written: [], data: { pages: 2 } };
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((entry) => entry.name), ['edit__get-info']);

      const result = await client.callTool({
        name: 'edit__get-info',
        arguments: { input_paths: ['/tmp/one.pdf'] },
      });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /"pages": 2/);
      assert.deepEqual(calls, [['edit.get-info', { input_paths: ['/tmp/one.pdf'] }]]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns an MCP tool error instead of crashing the server', async () => {
    const server = createMcpServer({
      catalog: [tool],
      callTool: async () => { throw new Error('local API unavailable'); },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: 'edit__get-info',
        arguments: { input_paths: ['/tmp/one.pdf'] },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /local API unavailable/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
