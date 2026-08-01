'use strict';

const crypto = require('node:crypto');
const { normalizeExternalMcpConfig } = require('./externalConfig.cjs');

const MAX_TOOL_COUNT = 200;
const MAX_TOOL_PAGES = 20;
const MAX_SCHEMA_CHARS = 64 * 1024;
const MAX_TOTAL_SCHEMA_CHARS = 1024 * 1024;
const MAX_RESULT_CHARS = 64 * 1024;

function slug(value, maxLength) {
  const normalized = String(value)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'tool';
  return normalized.slice(0, maxLength);
}

function externalFunctionName(serverId, toolName) {
  const hash = crypto.createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 8);
  return `mcp_${slug(serverId, 18)}_${slug(toolName, 24)}_${hash}`;
}

function redactError(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:token|key|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function providerTool(serverId, tool) {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {} };
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) {
    throw new Error(`MCP tool ${serverId}/${tool.name} input schema is too large`);
  }
  const functionName = externalFunctionName(serverId, tool.name);
  const title = String(tool.title || tool.name);
  const description = `[External MCP: ${serverId}] ${String(tool.description || title)}`.slice(0, 2048);
  return {
    functionName,
    serverId,
    toolName: tool.name,
    toolId: `mcp:${serverId}:${tool.name}`,
    name: { zh: `${serverId} · ${title}`, en: `${serverId} · ${title}` },
    providerTool: {
      type: 'function',
      function: {
        name: functionName,
        description,
        parameters: schema.type === 'object' ? schema : { type: 'object', properties: {} },
      },
    },
  };
}

function normalizeMcpResult(result, maxChars = MAX_RESULT_CHARS) {
  const parts = [];
  for (const item of result?.content || []) {
    if (item?.type === 'text') {
      parts.push(String(item.text || ''));
    } else if (item?.type === 'resource' && typeof item.resource?.text === 'string') {
      parts.push(`[Resource ${item.resource.uri || ''}]\n${item.resource.text}`);
    } else if (item?.type === 'resource_link') {
      parts.push(`[Resource link: ${item.name || ''} (${item.uri || ''})]`);
    } else if (item?.type === 'image' || item?.type === 'audio') {
      parts.push(`[${item.type} ${item.mimeType || 'application/octet-stream'} omitted]`);
    } else if (item?.type === 'resource') {
      parts.push(`[Binary resource ${item.resource?.uri || ''} omitted]`);
    }
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    parts.push(JSON.stringify(result.structuredContent));
  }
  const text = parts.filter(Boolean).join('\n\n') || '(External MCP tool returned no text content.)';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars))}\n[truncated]`;
}

async function defaultConnectServer(server, { version, signal }) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  let transport;
  if (server.transport === 'stdio') {
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
  } else {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  }
  const client = new Client({ name: 'magies-office', version }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 15000, signal });
    return client;
  } catch (cause) {
    try {
      await client.close();
    } catch {
      // The transport may have failed before it fully opened.
    }
    throw cause;
  }
}

async function listServerTools(client, serverId, signal) {
  const tools = [];
  let cursor;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const response = await client.listTools(
      cursor ? { cursor } : undefined,
      { timeout: 15000, signal },
    );
    for (const tool of response.tools || []) {
      if (typeof tool.name !== 'string' || !tool.name) continue;
      tools.push(providerTool(serverId, tool));
      if (tools.length > MAX_TOOL_COUNT) {
        throw new Error(`MCP server ${serverId} exposes more than ${MAX_TOOL_COUNT} tools`);
      }
    }
    cursor = response.nextCursor;
    if (!cursor) return tools;
  }
  throw new Error(`MCP server ${serverId} returned too many tool pages`);
}

function createExternalMcpClientManager({
  secretStore,
  connectServer = defaultConnectServer,
  version = '2.0.0',
}) {
  let initialized = false;
  let fingerprint = '';
  let statuses = [];
  let capabilities = [];
  let connections = new Map();
  let refreshPromise = null;
  let refreshController = null;

  const rawConfig = () => secretStore.getMcpConfig?.() || '';

  const closeConnections = async () => {
    const current = [...connections.values()];
    connections = new Map();
    await Promise.all(current.map(async (client) => {
      try {
        await client.close();
      } catch {
        // The child process or remote connection is already gone.
      }
    }));
  };

  const configuredStatuses = () => {
    const raw = rawConfig();
    if (!raw) return [];
    try {
      return normalizeExternalMcpConfig(raw).servers.map((server) => ({
        id: server.id,
        transport: server.transport,
        enabled: server.enabled,
        state: server.enabled ? 'disconnected' : 'disabled',
        toolCount: 0,
        error: '',
      }));
    } catch (cause) {
      return [{
        id: 'configuration',
        transport: 'unknown',
        enabled: false,
        state: 'error',
        toolCount: 0,
        error: redactError(cause),
      }];
    }
  };

  const refreshNow = async ({ signal } = {}) => {
    await closeConnections();
    capabilities = [];
    const raw = rawConfig();
    fingerprint = raw;
    initialized = true;
    if (!raw) {
      statuses = [];
      return { configured: false, servers: [] };
    }

    const config = normalizeExternalMcpConfig(raw);
    statuses = config.servers.map((server) => ({
      id: server.id,
      transport: server.transport,
      enabled: server.enabled,
      state: server.enabled ? 'connecting' : 'disabled',
      toolCount: 0,
      error: '',
    }));

    for (let index = 0; index < config.servers.length; index += 1) {
      const server = config.servers[index];
      if (!server.enabled) continue;
      let client;
      try {
        client = await connectServer(server, { version, signal });
        const tools = await listServerTools(client, server.id, signal);
        if (capabilities.length + tools.length > MAX_TOOL_COUNT) {
          throw new Error(`External MCP servers expose more than ${MAX_TOOL_COUNT} tools in total`);
        }
        const schemaChars = [...capabilities, ...tools]
          .reduce((total, tool) => total + JSON.stringify(tool.providerTool.function.parameters).length, 0);
        if (schemaChars > MAX_TOTAL_SCHEMA_CHARS) {
          throw new Error('External MCP tool schemas are too large in total');
        }
        connections.set(server.id, client);
        capabilities.push(...tools);
        statuses[index] = { ...statuses[index], state: 'connected', toolCount: tools.length };
      } catch (cause) {
        try {
          await client?.close();
        } catch {
          // The failed connection has nothing left to close.
        }
        statuses[index] = { ...statuses[index], state: 'error', error: redactError(cause) };
      }
    }
    return { configured: true, servers: statuses.map((status) => ({ ...status })) };
  };

  const refresh = (options = {}) => {
    if (refreshPromise) return refreshPromise;
    const controller = new AbortController();
    refreshController = controller;
    const signal = options.signal
      ? globalThis.AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const running = refreshNow({ signal });
    const tracked = running.finally(() => {
      if (refreshPromise === tracked) refreshPromise = null;
      if (refreshController === controller) refreshController = null;
    });
    refreshPromise = tracked;
    return tracked;
  };

  const listTools = async (options = {}) => {
    if (!initialized || fingerprint !== rawConfig()) await refresh(options);
    return capabilities.map((tool) => ({ ...tool }));
  };

  const callTool = async (functionName, args, { signal, onProgress = () => {} } = {}) => {
    const tools = await listTools({ signal });
    const tool = tools.find((candidate) => candidate.functionName === functionName);
    if (!tool) throw new Error(`Unknown or unavailable external MCP tool: ${functionName}`);
    const client = connections.get(tool.serverId);
    if (!client) throw new Error(`External MCP server is not connected: ${tool.serverId}`);
    const result = await client.callTool(
      { name: tool.toolName, arguments: args || {} },
      undefined,
      {
        signal,
        timeout: 120000,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 10 * 60 * 1000,
        onprogress: ({ progress, total }) => {
          const fraction = typeof total === 'number' && total > 0 ? Number(progress) / total : 0;
          onProgress(Math.max(0, Math.min(1, fraction)));
        },
      },
    );
    const text = normalizeMcpResult(result);
    if (result?.isError) throw new Error(text);
    return text;
  };

  const getStatus = () => ({
    configured: Boolean(rawConfig()),
    servers: (initialized ? statuses : configuredStatuses()).map((status) => ({ ...status })),
  });

  const settleRefresh = async (abort = false) => {
    if (abort) refreshController?.abort();
    if (!refreshPromise) return;
    try {
      await refreshPromise;
    } catch {
      // The next operation can recover from a failed or cancelled refresh.
    }
  };

  const setConfig = async (value) => {
    normalizeExternalMcpConfig(value);
    await settleRefresh(true);
    secretStore.setMcpConfig(typeof value === 'string' ? value : JSON.stringify(value));
    return refresh();
  };

  const clearConfig = async () => {
    await settleRefresh(true);
    secretStore.setMcpConfig('');
    await closeConnections();
    initialized = true;
    fingerprint = '';
    statuses = [];
    capabilities = [];
    return { configured: false, servers: [] };
  };

  const close = async () => {
    await settleRefresh(true);
    await closeConnections();
    initialized = false;
    capabilities = [];
  };

  return { callTool, clearConfig, close, getStatus, listTools, refresh, setConfig };
}

module.exports = {
  createExternalMcpClientManager,
  defaultConnectServer,
  externalFunctionName,
  normalizeMcpResult,
};
