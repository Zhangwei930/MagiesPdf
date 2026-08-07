'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLI_AGENTS,
  agentById,
  configPathFor,
  mergeMcpServerIntoJson,
  tomlSnippetFor,
  searchDirectories,
  installArgsFor,
} = require('./cliAgents.cjs');

const ENTRY = {
  command: '/Applications/Magies Office.app/Contents/MacOS/Magies Office',
  args: ['/path/server.cjs'],
  env: { ELECTRON_RUN_AS_NODE: '1', MAGIES_OFFICE_API_TOKEN: 'tok' },
};

test('every agent declares a command and a config format', () => {
  assert.ok(CLI_AGENTS.length >= 8);
  for (const agent of CLI_AGENTS) {
    assert.ok(agent.id, 'id');
    assert.ok(agent.command, `${agent.id}: command`);
    assert.ok(['json', 'command', 'none'].includes(agent.format), `${agent.id}: format`);
    // Only an agent this app can configure needs somewhere to configure.
    if (agent.format !== 'none') {
      assert.ok(agent.configPath?.length > 0, `${agent.id}: configPath is empty`);
    }
    assert.ok(['json', 'toml'].includes(agent.snippet), `${agent.id}: snippet format`);
    assert.equal(typeof agent.runnable, 'boolean', `${agent.id}: runnable`);
  }
});

test('the fallback snippet matches the shape of that agent own config file', () => {
  const { snippetFor } = require('./cliAgents.cjs');
  // Kimi keeps JSON at ~/.kimi/mcp.json; handing it a TOML table would be
  // useless advice.
  assert.match(snippetFor(agentById('kimi'), 'magies-office', ENTRY), /"mcpServers"/);
  assert.match(snippetFor(agentById('codex'), 'magies-office', ENTRY), /\[mcp_servers\./);
});

test('an agent this app cannot drive is not offered as a chat backend', () => {
  // Their print-mode flags are unverified; offering them would fail at the
  // first turn rather than at configuration time.
  assert.equal(agentById('kimi').runnable, false);
  assert.equal(agentById('qoder').runnable, false);
  assert.equal(agentById('claude').runnable, true);
});

test('Antigravity is configured through the config it shares with the Gemini tooling', () => {
  const agy = agentById('antigravity');
  assert.equal(agy.command, 'agy');
  assert.equal(agy.format, 'json');
  assert.deepEqual(agy.configPath, ['.gemini', 'config', 'mcp_config.json']);
  // Distinct from Gemini CLI's own file, which is settings.json beside it.
  assert.notDeepEqual(agy.configPath, agentById('gemini').configPath);
});

test('an empty config file is filled in rather than treated as broken', () => {
  // Antigravity ships this file as zero bytes until something writes to it.
  const merged = mergeMcpServerIntoJson('', 'mcpServers', 'magies-office', ENTRY);
  assert.deepEqual(JSON.parse(merged), { mcpServers: { 'magies-office': ENTRY } });
});

test('the TOML agents are configured through their own mcp subcommand', () => {
  // Both keep their config in TOML, and both ship `mcp add`, so neither file is
  // ever parsed or rewritten by this app.
  for (const id of ['grok', 'codex']) {
    assert.equal(agentById(id).format, 'command', id);
  }
  assert.deepEqual(agentById('grok').configPath, ['.grok', 'config.toml']);
  assert.deepEqual(agentById('codex').configPath, ['.codex', 'config.toml']);
});

test('installArgsFor builds the grok invocation, server command last', () => {
  assert.deepEqual(installArgsFor(agentById('grok'), 'magies-office', ENTRY), [
    'mcp', 'add', 'magies-office',
    '--scope', 'user',
    '-e', 'ELECTRON_RUN_AS_NODE=1',
    '-e', 'MAGIES_OFFICE_API_TOKEN=tok',
    '--',
    '/Applications/Magies Office.app/Contents/MacOS/Magies Office',
    '/path/server.cjs',
  ]);
});

test('installArgsFor uses each agent own flag spelling', () => {
  // codex spells the environment flag --env and takes no scope; grok spells it
  // -e and needs --scope user. Getting either wrong fails at the CLI.
  assert.deepEqual(installArgsFor(agentById('codex'), 'magies-office', ENTRY), [
    'mcp', 'add', 'magies-office',
    '--env', 'ELECTRON_RUN_AS_NODE=1',
    '--env', 'MAGIES_OFFICE_API_TOKEN=tok',
    '--',
    '/Applications/Magies Office.app/Contents/MacOS/Magies Office',
    '/path/server.cjs',
  ]);
});

test('installArgsFor refuses an agent that is not configured by command', () => {
  assert.throws(() => installArgsFor(agentById('cursor'), 'magies-office', ENTRY), /not configured/i);
});

test('agentById resolves known agents only', () => {
  assert.equal(agentById('claude')?.command, 'claude');
  assert.equal(agentById('nope'), null);
});

test('configPathFor builds an absolute path under the home directory', () => {
  const agent = agentById('cursor');
  assert.equal(configPathFor(agent, '/Users/x'), '/Users/x/.cursor/mcp.json');
});

test('mergeMcpServerIntoJson adds the server to an empty file without inventing anything else', () => {
  const merged = mergeMcpServerIntoJson('', 'mcpServers', 'magies-office', ENTRY);
  assert.deepEqual(JSON.parse(merged), { mcpServers: { 'magies-office': ENTRY } });
});

test('mergeMcpServerIntoJson preserves every unrelated key and server', () => {
  const existing = JSON.stringify({
    theme: 'dark',
    mcpServers: { other: { command: 'other-mcp' } },
  });

  const merged = JSON.parse(mergeMcpServerIntoJson(existing, 'mcpServers', 'magies-office', ENTRY));
  assert.equal(merged.theme, 'dark');
  assert.deepEqual(merged.mcpServers.other, { command: 'other-mcp' });
  assert.deepEqual(merged.mcpServers['magies-office'], ENTRY);
});

test('mergeMcpServerIntoJson replaces a previous entry of ours rather than duplicating it', () => {
  const existing = JSON.stringify({
    mcpServers: { 'magies-office': { command: 'stale', args: [], env: {} } },
  });

  const merged = JSON.parse(mergeMcpServerIntoJson(existing, 'mcpServers', 'magies-office', ENTRY));
  assert.deepEqual(merged.mcpServers['magies-office'], ENTRY);
  assert.equal(Object.keys(merged.mcpServers).length, 1);
});

test('mergeMcpServerIntoJson supports a nested container without flattening it', () => {
  const existing = JSON.stringify({ projects: { a: 1 }, mcp: { servers: { old: {} } } });
  const merged = JSON.parse(mergeMcpServerIntoJson(existing, 'mcp.servers', 'magies-office', ENTRY));

  assert.deepEqual(merged.projects, { a: 1 });
  assert.deepEqual(Object.keys(merged.mcp.servers).sort(), ['magies-office', 'old']);
});

test('mergeMcpServerIntoJson refuses to clobber a file it cannot parse', () => {
  assert.throws(
    () => mergeMcpServerIntoJson('{ not json', 'mcpServers', 'magies-office', ENTRY),
    /could not be parsed/i,
  );
});

test('mergeMcpServerIntoJson refuses when the container is not an object', () => {
  assert.throws(
    () => mergeMcpServerIntoJson('{"mcpServers": []}', 'mcpServers', 'magies-office', ENTRY),
    /not an object/i,
  );
});

test('tomlSnippetFor emits a table the user can paste into config.toml', () => {
  const snippet = tomlSnippetFor('magies-office', ENTRY);
  assert.match(snippet, /\[mcp_servers\.magies-office\]/);
  assert.match(snippet, /command = "\/Applications\/Magies Office\.app\/Contents\/MacOS\/Magies Office"/);
  assert.match(snippet, /args = \["\/path\/server\.cjs"\]/);
  assert.match(snippet, /\[mcp_servers\.magies-office\.env\]/);
  assert.match(snippet, /MAGIES_OFFICE_API_TOKEN = "tok"/);
});

test('tomlSnippetFor escapes quotes and backslashes in Windows paths', () => {
  const snippet = tomlSnippetFor('magies-office', {
    command: 'C:\\Program Files\\Magies "Office"\\app.exe',
    args: [],
    env: {},
  });
  assert.match(snippet, /command = "C:\\\\Program Files\\\\Magies \\"Office\\"\\\\app\.exe"/);
});

test('searchDirectories covers the places a CLI is usually installed', () => {
  const dirs = searchDirectories({
    home: '/Users/x',
    platform: 'darwin',
    env: { PATH: '/usr/bin:/custom/bin' },
  });

  assert.ok(dirs.includes('/usr/bin'));
  assert.ok(dirs.includes('/custom/bin'));
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes('/Users/x/.local/bin'));
  // No duplicates: the list is walked once per agent.
  assert.equal(new Set(dirs).size, dirs.length);
});

test('searchDirectories splits PATH with the Windows separator on Windows', () => {
  const dirs = searchDirectories({
    home: 'C:\\Users\\x',
    platform: 'win32',
    env: { PATH: 'C:\\bin;C:\\other' },
  });

  assert.ok(dirs.includes('C:\\bin'));
  assert.ok(dirs.includes('C:\\other'));
});
