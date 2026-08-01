#!/usr/bin/env node
'use strict';

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { callRestTool, validateApiUrl } = require('./adapter.cjs');
const { createMcpServer } = require('./serverFactory.cjs');

async function loadCatalog(apiUrl, token) {
  const response = await fetch(`${apiUrl}/tools`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Magies Office API returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || !Array.isArray(payload.tools)) {
    throw new Error(payload.message || `Could not load Magies Office tools (HTTP ${response.status})`);
  }
  return payload.tools;
}

async function main() {
  const apiUrl = validateApiUrl(process.env.MAGIES_OFFICE_API_URL || '');
  const token = process.env.MAGIES_OFFICE_API_TOKEN || '';
  if (!token) throw new Error('MAGIES_OFFICE_API_TOKEN is required');

  const catalog = await loadCatalog(apiUrl, token);
  const server = createMcpServer({
    catalog,
    callTool: (tool, args) => callRestTool({ tool, args, apiUrl, token }),
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

module.exports = { loadCatalog, main };
