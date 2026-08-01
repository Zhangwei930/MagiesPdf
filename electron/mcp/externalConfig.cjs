'use strict';

const path = require('node:path');

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_SERVERS = 20;
const MAX_ARGS = 50;
const MAX_VALUES = 100;

function parseConfig(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_CONFIG_BYTES) {
      throw new Error('External MCP configuration is too large');
    }
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('External MCP configuration must be valid JSON');
    }
  }
  return value;
}

function stringRecord(value, label) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain string values`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_VALUES || entries.some(([key, item]) => !key || typeof item !== 'string')) {
    throw new Error(`${label} must contain at most ${MAX_VALUES} string values`);
  }
  return Object.fromEntries(entries);
}

function normalizeStdio(id, value) {
  if (typeof value.command !== 'string' || !value.command.trim()) {
    throw new Error(`MCP server ${id} command must be a non-empty string`);
  }
  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((item) => typeof item !== 'string')) {
    throw new Error(`MCP server ${id} args must contain at most ${MAX_ARGS} strings`);
  }
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd))) {
    throw new Error(`MCP server ${id} cwd must be an absolute path`);
  }
  return {
    id,
    enabled: value.disabled !== true,
    transport: 'stdio',
    command: value.command.trim(),
    args: [...args],
    ...(value.env === undefined ? {} : { env: stringRecord(value.env, `MCP server ${id} environment`) }),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
  };
}

function normalizeHttp(id, value) {
  if (typeof value.url !== 'string') throw new Error(`MCP server ${id} URL must be a string`);
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(`MCP server ${id} URL must be valid`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`MCP server ${id} URL must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`MCP server ${id} URL must not contain credentials`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (url.protocol === 'http:' && !loopback) {
    throw new Error(`MCP server ${id} must use HTTPS unless it is on loopback`);
  }
  return {
    id,
    enabled: value.disabled !== true,
    transport: 'http',
    url: url.href,
    ...(value.headers === undefined ? {} : { headers: stringRecord(value.headers, `MCP server ${id} headers`) }),
  };
}

function normalizeExternalMcpConfig(input) {
  const parsed = parseConfig(input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('External MCP configuration must be an object');
  }
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('External MCP configuration must contain mcpServers');
  }
  const entries = Object.entries(servers);
  if (entries.length > MAX_SERVERS) throw new Error(`At most ${MAX_SERVERS} MCP servers may be configured`);

  return {
    servers: entries.map(([id, value]) => {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
        throw new Error(`Invalid MCP server name: ${id}`);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`MCP server ${id} must be an object`);
      }
      const hasCommand = Object.prototype.hasOwnProperty.call(value, 'command');
      const hasUrl = Object.prototype.hasOwnProperty.call(value, 'url');
      if (hasCommand === hasUrl) {
        throw new Error(`MCP server ${id} must define exactly one of command or url`);
      }
      return hasCommand ? normalizeStdio(id, value) : normalizeHttp(id, value);
    }),
  };
}

module.exports = { normalizeExternalMcpConfig };
