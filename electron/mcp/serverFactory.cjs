'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { buildMcpTools, buildOfficeMcpTools } = require('./adapter.cjs');

/**
 * MCP server exposing both PDF catalog tools and Office automation tools.
 *
 * Catalog tools keep their encoded names (edit__get-info). Office tools use
 * the automation function names (office_excel_write) so agents call the same
 * surface as the built-in runtime.
 */
function createMcpServer({
  catalog = [],
  officeTools = [],
  callTool,
  callOfficeTool,
}) {
  const catalogDefinitions = buildMcpTools(catalog);
  const officeDefinitions = buildOfficeMcpTools(officeTools);

  const catalogByName = new Map();
  for (const definition of catalogDefinitions) {
    const tool = catalog.find((entry) => entry.id === definition.toolId);
    if (tool) catalogByName.set(definition.name, tool);
  }

  const officeByName = new Map();
  for (const definition of officeDefinitions) {
    officeByName.set(definition.name, definition);
  }

  const listed = [
    ...catalogDefinitions.map(({ toolId: _toolId, ...definition }) => definition),
    ...officeDefinitions.map(({ toolId: _toolId, kind: _kind, functionName: _fn, ...definition }) => definition),
  ];

  const server = new Server(
    { name: 'magies-office', version: require('../../package.json').version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listed,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments || {};

    try {
      if (officeByName.has(name)) {
        if (typeof callOfficeTool !== 'function') {
          throw new Error('Office automation is not available on this Magies Office MCP server');
        }
        const definition = officeByName.get(name);
        const result = await callOfficeTool(definition, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      const tool = catalogByName.get(name);
      if (!tool) {
        return {
          content: [{ type: 'text', text: `Unknown Magies Office tool: ${name}` }],
          isError: true,
        };
      }
      const result = await callTool(tool, args);
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
