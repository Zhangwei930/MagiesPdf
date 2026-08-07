#!/usr/bin/env node
'use strict';

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  callRestOfficeTool,
  callRestTool,
  validateApiUrl,
} = require('./adapter.cjs');
const { createMcpServer } = require('./serverFactory.cjs');

async function loadJson(apiUrl, token, route) {
  const response = await fetch(`${apiUrl}${route}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Magies Office API returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(payload.message || `Could not load Magies Office ${route} (HTTP ${response.status})`);
  }
  return payload;
}

async function loadCatalog(apiUrl, token) {
  const payload = await loadJson(apiUrl, token, '/tools');
  if (!Array.isArray(payload.tools)) {
    throw new Error('Magies Office API returned no tools list');
  }
  return payload.tools;
}

/**
 * Office automation tools. Missing route (older app builds) yields an empty
 * list rather than killing the whole MCP server — PDF tools still work.
 */
async function loadOfficeTools(apiUrl, token) {
  try {
    const payload = await loadJson(apiUrl, token, '/office/tools');
    return Array.isArray(payload.tools) ? payload.tools : [];
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/404|No such route|not_found/i.test(message)) return [];
    throw cause;
  }
}

async function main() {
  const apiUrl = validateApiUrl(process.env.MAGIES_OFFICE_API_URL || '');
  const token = process.env.MAGIES_OFFICE_API_TOKEN || '';
  if (!token) throw new Error('MAGIES_OFFICE_API_TOKEN is required');

  const [catalog, officeTools] = await Promise.all([
    loadCatalog(apiUrl, token),
    loadOfficeTools(apiUrl, token),
  ]);

  const server = createMcpServer({
    catalog,
    officeTools,
    callTool: (tool, args) => callRestTool({ tool, args, apiUrl, token }),
    callOfficeTool: (definition, args) => callRestOfficeTool({
      functionName: definition.functionName || definition.name,
      args,
      apiUrl,
      token,
    }),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((cause) => {
    process.stderr.write(`[magies-office-mcp] ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { loadCatalog, loadOfficeTools, main };
