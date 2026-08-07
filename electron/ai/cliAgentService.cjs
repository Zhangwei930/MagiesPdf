'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  CLI_AGENTS,
  agentById,
  configPathFor,
  searchDirectories,
  mergeMcpServerIntoJson,
  snippetFor,
  installArgsFor,
} = require('./cliAgents.cjs');
const { modelListArgsFor, modelPresetsFor, parseModelList } = require('./agentModels.cjs');

const SERVER_NAME = 'magies-office';
const VERSION_TIMEOUT_MS = 3000;

function defaultProbeVersion(binary) {
  // Same reason as defaultRunCommand: a CLI given an open stdin may wait on it
  // instead of printing its version, and detection would stall on every launch.
  return defaultRunCommand(binary, ['--version'], { timeout: VERSION_TIMEOUT_MS })
    .then(({ code, stdout }) => {
      if (code !== 0) return '';
      // Agents print anything from "1.2.3" to "codex-cli 0.9 (rev abc)".
      const match = String(stdout || '').match(/\d+\.\d+(\.\d+)?/);
      return match ? match[0] : String(stdout || '').trim().split('\n')[0].slice(0, 40);
    });
}

/**
 * Runs a CLI subcommand and collects its output.
 *
 * `spawn` rather than `execFile` for one reason: execFile always hands the
 * child an open stdin pipe and ignores a `stdio` option, and these CLIs wait on
 * stdin when it is not a terminal — `agy models` hangs until the timeout kills
 * it and returns nothing. Closing stdin makes them answer and exit.
 */
function defaultRunCommand(binary, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Finds installed coding-agent CLIs and hands them the local MCP server.
 *
 * Writing into a file another program owns is the risky part, so it is done in
 * one place and defensively: parse first (refusing to touch a file we cannot
 * read), keep a backup, then replace atomically through a temp file in the same
 * directory. Agents whose format we cannot round-trip get a snippet instead of
 * a write — see `cliAgents.cjs`.
 */
function createCliAgentService({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  fileExists = (candidate) => fs.existsSync(candidate),
  probeVersion = defaultProbeVersion,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  writeFile,
  runCommand = defaultRunCommand,
  mcpConfig,
} = {}) {
  const suffixes = platform === 'win32' ? ['.cmd', '.exe', '.ps1', ''] : [''];

  const locate = (command) => {
    for (const directory of searchDirectories({ home, platform, env })) {
      for (const suffix of suffixes) {
        const candidate = path.join(directory, `${command}${suffix}`);
        if (fileExists(candidate)) return candidate;
      }
    }
    return '';
  };

  const serverEntry = () => {
    const status = mcpConfig();
    if (!status?.ready) {
      const error = new Error('The local MCP server is not ready');
      error.code = 'MCP_NOT_READY';
      throw error;
    }
    return status.config.mcpServers[SERVER_NAME];
  };

  const alreadyInstalled = (agent) => {
    if (agent.format === 'none') return false;
    const file = configPathFor(agent, home);
    if (!file || !fileExists(file)) return false;
    let text;
    try {
      text = readFile(file);
    } catch {
      return false;
    }

    try {
      const parsed = JSON.parse(text);
      const container = agent.container.split('.')
        .reduce((node, segment) => (node && typeof node === 'object' ? node[segment] : undefined), parsed);
      return Boolean(container && typeof container === 'object' && container[SERVER_NAME]);
    } catch {
      // Not JSON — a TOML config. Rather than pull in a parser to answer one
      // yes/no question, look for the table this app would have written.
      return text.includes(`${agent.container}.${SERVER_NAME}`) || text.includes(`"${SERVER_NAME}"`);
    }
  };

  const defaultWriteFile = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.magies-backup`);
    const temporary = `${file}.magies-tmp`;
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  };

  const write = writeFile || defaultWriteFile;

  /**
   * Model lists, remembered for the life of the process.
   *
   * Asking costs a process launch — about a second — and the answer changes
   * only when the CLI is updated. Without this the dropdown asked on every
   * open, so the shipped fallback showed first and was replaced a moment later,
   * which reads as the list flickering. Only successful answers are kept: a
   * failure is usually "not logged in yet" and should be retried.
   */
  const modelCache = new Map();

  return {
    async detect() {
      return Promise.all(CLI_AGENTS.map(async (agent) => {
        const binary = locate(agent.command);
        return {
          id: agent.id,
          name: agent.name,
          command: agent.command,
          format: agent.format,
          runnable: agent.runnable !== false,
          configPath: configPathFor(agent, home),
          path: binary,
          installed: Boolean(binary),
          version: binary ? await probeVersion(binary) : '',
          mcpInstalled: alreadyInstalled(agent),
        };
      }));
    },

    /**
     * The models this agent offers right now.
     *
     * Asked of the CLI where it can answer, because the shipped list goes
     * stale — `agy` reports gemini-3.6 while the static list knows 3.5. The
     * static list is the fallback, not the source of truth.
     */
    async listModels(agentId) {
      const agent = agentById(agentId);
      if (!agent) return [];

      const cached = modelCache.get(agentId);
      if (cached) return cached;

      const fallback = modelPresetsFor(agentId);
      const args = modelListArgsFor(agentId);
      const binary = args ? locate(agent.command) : '';
      if (!args || !binary) return fallback;

      try {
        const { code, stdout } = await runCommand(binary, args);
        const ids = code === 0 ? parseModelList(agentId, stdout) : [];
        if (ids.length === 0) return fallback;

        const labels = new Map(fallback.map((preset) => [preset.id, preset]));
        const models = ids.map((id) => labels.get(id) ?? { id, name: id });
        modelCache.set(agentId, models);
        return models;
      } catch {
        return fallback;
      }
    },

    /**
     * Adds the local MCP server to one agent's configuration. Returns
     * `{ ok: false, snippet }` for agents we deliberately do not write.
     */
    async install(agentId) {
      const agent = agentById(agentId);
      if (!agent) throw new Error(`Unknown CLI agent: ${agentId}`);

      if (agent.format === 'none') {
        const error = new Error(`${agent.name} exposes no MCP configuration to write to`);
        error.code = 'CLI_NO_MCP_SURFACE';
        throw error;
      }

      const entry = serverEntry();

      // Agents that ship their own `mcp add` configure themselves: no file of
      // theirs is parsed or rewritten by this app.
      if (agent.format === 'command') {
        const binary = locate(agent.command);
        if (!binary) throw new Error(`${agent.name} is not installed on this machine`);
        const { code, stderr } = await runCommand(binary, installArgsFor(agent, SERVER_NAME, entry));
        if (code === 0) {
          return { ok: true, agentId, path: configPathFor(agent, home), snippet: '', error: '' };
        }
        // These CLIs rename flags between versions. Rather than leave the user
        // at a dead end, hand back the table they can paste themselves.
        return {
          ok: false,
          agentId,
          path: configPathFor(agent, home),
          snippet: snippetFor(agent, SERVER_NAME, entry),
          error: stderr.trim() || `${agent.command} exited with code ${code}`,
        };
      }

      const file = configPathFor(agent, home);
      const existing = fileExists(file) ? readFile(file) : '';
      const merged = mergeMcpServerIntoJson(existing, agent.container, SERVER_NAME, entry);
      write(file, merged);

      return { ok: true, agentId, path: file, snippet: '', error: '' };
    },
  };
}

module.exports = { createCliAgentService, SERVER_NAME };
