'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { buildMcpTools } = require('./adapter.cjs');

function createMcpServer({ catalog, callTool }) {
  const definitions = buildMcpTools(catalog);
  const toolsByName = new Map();
  for (const definition of definitions) {
    const tool = catalog.find((entry) => entry.id === definition.toolId);
    if (tool) toolsByName.set(definition.name, tool);
  }

  const server = new Server(
    { name: 'magies-office', version: require('../../package.json').version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map(({ toolId: _toolId, ...definition }) => definition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown Magies Office tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const result = await callTool(tool, request.params.arguments || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (cause) {
      return {
        content: [{
          type: 'text',
          text: cause instanceof Error ? cause.message : String(cause),
        }],
        isError: true,
      };
    }
  });

  return server;
}

module.exports = { createMcpServer };
