'use strict';

const path = require('node:path');

/**
 * Coding-agent CLIs installed on this machine, and how to hand them the local
 * MCP server so they can call Magies Office tools.
 *
 * Only agents whose configuration format is known for certain get a one-click
 * write: this code edits a file another program owns, so guessing a schema is
 * how you corrupt somebody's setup. Anything less certain is `format: 'toml'`
 * or simply absent, and the pane offers a snippet to paste instead.
 *
 * Pure: paths are built from an injected home directory and detection is done
 * by the caller. Everything here is testable without a filesystem.
 */

const CLI_AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    /** Under the home directory. */
    configPath: ['.claude.json'],
    format: 'json',
    /** Dotted path to the object that holds the servers. */
    container: 'mcpServers',
    snippet: 'json',
    runnable: true,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    command: 'cursor-agent',
    configPath: ['.cursor', 'mcp.json'],
    format: 'json',
    container: 'mcpServers',
    snippet: 'json',
    runnable: true,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    configPath: ['.gemini', 'settings.json'],
    format: 'json',
    container: 'mcpServers',
    snippet: 'json',
    runnable: true,
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    command: 'kimi',
    configPath: ['.kimi', 'mcp.json'],
    // `kimi mcp add … --env K=V -- <command>` configures it, so its own file is
    // left alone; the fallback snippet has to be JSON, not TOML, because that
    // is what `~/.kimi/mcp.json` is.
    format: 'command',
    container: 'mcpServers',
    install: { envFlag: '--env', extraArgs: [] },
    snippet: 'json',
    // Its print-mode flags are unverified, so it is not offered as a chat
    // backend yet — it would fail at the first turn.
    runnable: false,
  },
  {
    id: 'qoder',
    name: 'Qoder CLI',
    command: 'qodercli',
    configPath: ['.qoder', 'settings.json'],
    // `qodercli mcp add` documents no flag for environment variables, and this
    // server needs three, so the file is the only route. The container key is
    // the de-facto `mcpServers`, which the merge leaves harmless if wrong: it
    // adds one unused object and touches nothing else.
    format: 'json',
    container: 'mcpServers',
    snippet: 'json',
    runnable: false,
  },
  {
    id: 'antigravity',
    name: 'Antigravity (agy)',
    command: 'agy',
    // Antigravity 2.0 shares one MCP config between the IDE, the `agy` CLI and
    // the SDK. It is not under the app-support tree, which is why looking there
    // found nothing: it sits beside Gemini's, in its own `config` directory.
    configPath: ['.gemini', 'config', 'mcp_config.json'],
    format: 'json',
    container: 'mcpServers',
    snippet: 'json',
    runnable: true,
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    command: 'grok',
    configPath: ['.grok', 'config.toml'],
    // TOML like Codex, but Grok ships `grok mcp add`, so it configures itself
    // and this app never has to parse or rewrite that file.
    format: 'command',
    container: 'mcp_servers',
    install: { envFlag: '-e', extraArgs: ['--scope', 'user'] },
    snippet: 'toml',
    runnable: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    configPath: ['.codex', 'config.toml'],
    // Also TOML, and also self-configuring — but it spells the environment flag
    // `--env` and has no scope option.
    format: 'command',
    container: 'mcp_servers',
    install: { envFlag: '--env', extraArgs: [] },
    snippet: 'toml',
    runnable: true,
  },
];

function agentById(id) {
  return CLI_AGENTS.find((agent) => agent.id === id) ?? null;
}

function configPathFor(agent, home) {
  return agent.configPath?.length ? path.join(home, ...agent.configPath) : '';
}

/** Directories worth scanning for a CLI, PATH first, then the usual installs. */
function searchDirectories({ home, platform, env }) {
  const separator = platform === 'win32' ? ';' : ':';
  const fromPath = String(env?.PATH || env?.Path || '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const common = platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm'),
        path.join(home, '.bun', 'bin'),
      ]
    : [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.npm-global', 'bin'),
      ];

  return [...new Set([...fromPath, ...common])];
}

function readContainer(root, container) {
  const segments = container.split('.');
  let node = root;
  for (const segment of segments) {
    if (node[segment] === undefined) node[segment] = {};
    if (node[segment] === null || typeof node[segment] !== 'object' || Array.isArray(node[segment])) {
      throw new Error(`"${container}" is not an object in this configuration file`);
    }
    node = node[segment];
  }
  return node;
}

/**
 * Adds (or replaces) one MCP server in a JSON configuration file, leaving every
 * other key exactly as it was. Throws rather than overwrite a file it cannot
 * parse — a malformed config is the user's to fix, not ours to discard.
 */
function mergeMcpServerIntoJson(existingText, container, serverName, entry) {
  const text = String(existingText || '').trim();

  let root = {};
  if (text) {
    try {
      root = JSON.parse(text);
    } catch {
      throw new Error('The existing configuration file could not be parsed as JSON');
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      throw new Error('The existing configuration file is not an object');
    }
  }

  const servers = readContainer(root, container);
  servers[serverName] = entry;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * Arguments for an agent that configures itself. Everything after `--` is the
 * server command, which is what keeps a server flag from being read as a flag
 * for the agent.
 */
function installArgsFor(agent, serverName, entry) {
  if (agent?.format !== 'command') {
    throw new Error(`${agent?.id ?? 'agent'} is not configured by command`);
  }
  const { envFlag, extraArgs } = agent.install;
  const env = Object.entries(entry.env || {})
    .flatMap(([key, value]) => [envFlag, `${key}=${value}`]);
  return [
    'mcp', 'add', serverName,
    ...extraArgs,
    ...env,
    '--',
    entry.command,
    ...(entry.args || []),
  ];
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The table to paste into a TOML-configured agent, e.g. Codex's config.toml. */
function tomlSnippetFor(serverName, entry) {
  const lines = [
    `[mcp_servers.${serverName}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${(entry.args || []).map(tomlString).join(', ')}]`,
  ];

  const env = Object.entries(entry.env || {});
  if (env.length > 0) {
    lines.push('', `[mcp_servers.${serverName}.env]`);
    for (const [key, value] of env) lines.push(`${key} = ${tomlString(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The block to paste for an agent whose configuration file is JSON. */
function jsonSnippetFor(serverName, entry) {
  return `${JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2)}\n`;
}

/** Whichever snippet matches the agent's own configuration file. */
function snippetFor(agent, serverName, entry) {
  return agent.snippet === 'toml'
    ? tomlSnippetFor(serverName, entry)
    : jsonSnippetFor(serverName, entry);
}

module.exports = {
  CLI_AGENTS,
  agentById,
  configPathFor,
  searchDirectories,
  mergeMcpServerIntoJson,
  tomlSnippetFor,
  jsonSnippetFor,
  snippetFor,
  installArgsFor,
};
