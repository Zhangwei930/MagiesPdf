'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createCliAgentService } = require('./cliAgentService.cjs');

function serviceWith(overrides = {}) {
  return createCliAgentService({
    home: '/home/u',
    platform: 'linux',
    env: { PATH: '/bin' },
    fileExists: () => false,
    probeVersion: async () => '',
    readFile: () => '',
    writeFile: () => {},
    runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
    mcpConfig: () => ({
      ready: true,
      config: {
        mcpServers: {
          'magies-office': { command: '/app/Magies', args: ['/app/server.cjs'], env: { T: '1' } },
        },
      },
    }),
    ...overrides,
  });
}

test('a CLI subcommand is never given an open stdin', async () => {
  // execFile always hands the child a stdin pipe and ignores a stdio option;
  // these CLIs then wait on it instead of answering, and `agy models` hangs
  // until the timeout kills it. The service must spawn with stdin closed.
  const source = require('node:fs').readFileSync(require.resolve('./cliAgentService.cjs'), 'utf8');
  assert.match(source, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.doesNotMatch(source, /execFile\(/);
});

test('detect reports every known agent, installed or not', async () => {
  const service = serviceWith();
  const agents = await service.detect();

  assert.ok(agents.length >= 4);
  assert.equal(agents.every((agent) => agent.installed === false), true);
  assert.equal(agents.every((agent) => agent.mcpInstalled === false), true);
});

test('detect finds a binary in a search directory and reports its version', async () => {
  const service = serviceWith({
    fileExists: (candidate) => candidate === path.join('/bin', 'claude'),
    probeVersion: async () => '1.2.3',
  });

  const claude = (await service.detect()).find((agent) => agent.id === 'claude');
  assert.equal(claude.installed, true);
  assert.equal(claude.path, '/bin/claude');
  assert.equal(claude.version, '1.2.3');
});

test('detect reports whether our server is already in the agent configuration', async () => {
  const service = serviceWith({
    fileExists: (candidate) => candidate.endsWith('.claude.json') || candidate === '/bin/claude',
    readFile: () => JSON.stringify({ mcpServers: { 'magies-office': { command: 'x' } } }),
  });

  const claude = (await service.detect()).find((agent) => agent.id === 'claude');
  assert.equal(claude.mcpInstalled, true);
});

test('detect survives an unreadable or malformed agent configuration', async () => {
  const service = serviceWith({
    fileExists: () => true,
    readFile: () => '{ broken',
  });

  const agents = await service.detect();
  assert.equal(agents.every((agent) => agent.mcpInstalled === false), true);
});

test('listModels asks the CLI once and serves the rest from memory', async () => {
  let calls = 0;
  const service = serviceWith({
    fileExists: (candidate) => candidate === '/bin/agy',
    runCommand: async () => {
      calls += 1;
      return { code: 0, stdout: 'gemini-3.6-flash-high\ngemini-3.6-flash-low\n', stderr: '' };
    },
  });

  const first = await service.listModels('antigravity');
  const second = await service.listModels('antigravity');

  // Spawning the CLI takes about a second; doing it on every dropdown open is
  // what made the list visibly swap under the user.
  assert.equal(calls, 1);
  assert.deepEqual(second.map((entry) => entry.id), first.map((entry) => entry.id));
  assert.deepEqual(first.map((entry) => entry.id), ['gemini-3.6-flash-high', 'gemini-3.6-flash-low']);
});

test('a failed listing is not cached, so the next try can still succeed', async () => {
  let calls = 0;
  const service = serviceWith({
    fileExists: (candidate) => candidate === '/bin/agy',
    runCommand: async () => {
      calls += 1;
      return calls === 1
        ? { code: 1, stdout: '', stderr: 'not logged in' }
        : { code: 0, stdout: 'gemini-3.6-flash-high\n', stderr: '' };
    },
  });

  await service.listModels('antigravity');
  const second = await service.listModels('antigravity');

  assert.equal(calls, 2);
  assert.deepEqual(second.map((entry) => entry.id), ['gemini-3.6-flash-high']);
});

test('install writes the merged configuration and reports the path it touched', async () => {
  const writes = [];
  const service = serviceWith({
    fileExists: (candidate) => candidate.endsWith('mcp.json'),
    readFile: () => JSON.stringify({ theme: 'dark' }),
    writeFile: (file, contents) => writes.push({ file, contents }),
  });

  const result = await service.install('cursor');

  assert.equal(result.ok, true);
  assert.equal(result.path, path.join('/home/u', '.cursor', 'mcp.json'));
  assert.equal(writes.length, 1);
  const written = JSON.parse(writes[0].contents);
  assert.equal(written.theme, 'dark');
  assert.deepEqual(written.mcpServers['magies-office'].args, ['/app/server.cjs']);
});

test('a failed self-configuration hands back a snippet rather than a dead end', async () => {
  const writes = [];
  const service = serviceWith({
    fileExists: (candidate) => candidate === '/bin/codex',
    runCommand: async () => ({ code: 2, stderr: 'unknown flag --env' }),
    writeFile: (file, contents) => writes.push({ file, contents }),
  });

  const result = await service.install('codex');

  assert.equal(result.ok, false);
  assert.equal(writes.length, 0, 'its config file is never touched');
  assert.match(result.error, /unknown flag/);
  assert.match(result.snippet, /\[mcp_servers\.magies-office\]/);
});

test('install lets a command-configured agent configure itself', async () => {
  const runs = [];
  const service = serviceWith({
    fileExists: (candidate) => candidate === '/bin/grok',
    runCommand: async (binary, args) => {
      runs.push({ binary, args });
      return { code: 0, stderr: '' };
    },
  });

  const result = await service.install('grok');

  assert.equal(result.ok, true);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args.slice(0, 5), ['mcp', 'add', 'magies-office', '--scope', 'user']);
  assert.equal(runs[0].args.at(-1), '/app/server.cjs');
});

test('install reports why the agent rejected its own command', async () => {
  const service = serviceWith({
    fileExists: (candidate) => candidate === '/bin/grok',
    runCommand: async () => ({ code: 1, stderr: 'server already exists' }),
  });
  const result = await service.install('grok');
  assert.equal(result.ok, false);
  assert.match(result.error, /already exists/);
});

test('detect finds our server in a TOML configuration by name', async () => {
  const service = serviceWith({
    fileExists: (candidate) => candidate.endsWith('config.toml') || candidate === '/bin/grok',
    readFile: () => '[mcp_servers.magies-office]\ncommand = "x"\n',
  });

  const grok = (await service.detect()).find((agent) => agent.id === 'grok');
  assert.equal(grok.mcpInstalled, true);
});

test('install refuses when the local MCP server is not ready', async () => {
  const service = serviceWith({ mcpConfig: () => ({ ready: false, config: { mcpServers: {} } }) });
  await assert.rejects(() => service.install('cursor'), /not ready/i);
});

test('install rejects an unknown agent', async () => {
  await assert.rejects(() => serviceWith().install('nope'), /unknown/i);
});

test('install never destroys a configuration file it cannot parse', async () => {
  const writes = [];
  const service = serviceWith({
    fileExists: (candidate) => candidate.endsWith('mcp.json'),
    readFile: () => '{ not json',
    writeFile: (file, contents) => writes.push({ file, contents }),
  });

  await assert.rejects(() => service.install('cursor'), /could not be parsed/i);
  assert.equal(writes.length, 0);
});

test('the default writer replaces the file atomically and keeps a backup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ theme: 'dark' }));

  const service = createCliAgentService({
    home: dir,
    platform: 'linux',
    env: { PATH: '/bin' },
    probeVersion: async () => '',
    mcpConfig: () => ({
      ready: true,
      config: { mcpServers: { 'magies-office': { command: '/app/Magies', args: [], env: {} } } },
    }),
  });

  const result = await service.install('cursor');

  assert.equal(result.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).theme, 'dark');
  assert.equal(fs.existsSync(`${target}.magies-backup`), true);
  assert.equal(JSON.parse(fs.readFileSync(`${target}.magies-backup`, 'utf8')).theme, 'dark');
});
