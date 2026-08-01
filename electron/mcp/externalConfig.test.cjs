'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { normalizeExternalMcpConfig } = require('./externalConfig.cjs');

describe('external MCP configuration', () => {
  it('accepts standard stdio and Streamable HTTP server entries', () => {
    const config = normalizeExternalMcpConfig(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
          env: { FILESYSTEM_ROOT: '/workspace' },
          cwd: '/workspace',
        },
        notion: {
          type: 'http',
          url: 'https://mcp.notion.example/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
      },
    }));

    assert.deepEqual(config.servers, [
      {
        id: 'filesystem',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        env: { FILESYSTEM_ROOT: '/workspace' },
        cwd: '/workspace',
      },
      {
        id: 'notion',
        enabled: true,
        transport: 'http',
        url: 'https://mcp.notion.example/mcp',
        headers: { Authorization: 'Bearer secret' },
      },
    ]);
  });

  it('retains disabled servers without activating them', () => {
    const config = normalizeExternalMcpConfig({
      mcpServers: {
        mail: { command: 'mail-mcp', disabled: true },
      },
    });
    assert.equal(config.servers[0].enabled, false);
  });

  it('rejects ambiguous, unsafe, and oversized configurations', () => {
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: { bad: { command: 'node', url: 'https://example.com/mcp' } } }),
      /exactly one/i,
    );
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: { bad: { command: 'node', cwd: 'relative' } } }),
      /absolute/i,
    );
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: { bad: { url: 'file:///tmp/mcp' } } }),
      /HTTP/i,
    );
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: { bad: { url: 'http://example.com/mcp' } } }),
      /HTTPS/i,
    );
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: { bad: { url: 'https://user:secret@example.com/mcp' } } }),
      /credentials/i,
    );
    assert.equal(
      normalizeExternalMcpConfig({ mcpServers: { local: { url: 'http://127.0.0.1:3000/mcp' } } }).servers[0].transport,
      'http',
    );
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [`server-${index}`, { command: 'node' }]),
      ) }),
      /20/i,
    );
  });

  it('rejects malformed names and non-string process values', () => {
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: { 'bad name': { command: 'node' } } }),
      /server name/i,
    );
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: { bad: { command: 'node', args: ['ok', 1] } } }),
      /args/i,
    );
    assert.throws(
      () => normalizeExternalMcpConfig({ mcpServers: { bad: { command: 'node', env: { TOKEN: 42 } } } }),
      /environment/i,
    );
  });
});
