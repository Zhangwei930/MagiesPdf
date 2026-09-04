'use strict';

/**
 * Terminal-style policy for external coding CLIs launched from Magies Office.
 *
 * The CLI is the brain; Magies Office tools (magies-office MCP / local REST) are
 * the hands. App permission modes gate those hands on the API side; this module
 * shapes the CLI prompt and spawn flags so the agent prefers Magies tools and
 * does not get a wider local grant than the user selected.
 */

/** Read-only Office automation tools (safe in observer mode). */
const OFFICE_READ_FUNCTION_NAMES = new Set([
  'office_workspace_list',
  'office_word_read',
  'office_word_read_changes',
  'office_excel_read',
  'office_presentation_read',
]);

function isOfficeReadTool(functionName) {
  return OFFICE_READ_FUNCTION_NAMES.has(String(functionName || ''));
}

function isOfficeWriteTool(functionName) {
  const name = String(functionName || '');
  if (!name.startsWith('office_')) return false;
  return !isOfficeReadTool(name);
}

/**
 * How each CLI is told it may accept Magies MCP tool results without a second
 * interactive prompt. Only used in Magies "auto" mode.
 *
 * Never pair this with --dangerously-skip-permissions: Magies Office must not
 * hand the CLI a shell-level bypass (same idea as Magies Terminal).
 */
const ACCEPT_EDITS_ARGS = {
  claude: ['--permission-mode', 'acceptEdits'],
  antigravity: ['--mode', 'accept-edits'],
  // Not `--mode`: gemini has no such flag. Its own spelling is
  // `--approval-mode`, whose values are default | auto_edit | yolo | plan.
  gemini: ['--approval-mode', 'auto_edit'],
};

/**
 * What a CLI is granted in Magies "automatic", beyond accepting edits.
 *
 * A CLI in print mode cannot show its own approval prompt, so anything it would
 * have asked about is auto-denied and the agent quietly does less than it was
 * asked — the "no output produced" failure. Automatic is the mode where the
 * user has already said yes, so the grant is passed on.
 *
 * The grant is scoped, not blanket. Each CLI runs with the granted Office
 * folder as its working directory: Claude is handed the tools it needs and
 * Codex is put in `workspace-write`, which lets it work inside that directory
 * and nowhere else. Neither is given the flag that turns off sandboxing for the
 * whole machine — the authorisation the user gave was for a folder.
 */
const WORKSPACE_GRANT_ARGS = {
  claude: ['--allowedTools', 'Bash Edit Write Read Glob Grep WebFetch WebSearch'],
  // `codex exec` dropped `--ask-for-approval`, and passing it now exits with
  // code 2 before the turn starts. The same policy is a config override:
  // `codex doctor -c approval_policy="never"` reports it back as Never.
  codex: ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"'],
};

/**
 * Spawn flags that would strip a CLI's own capabilities.
 *
 * Deliberately empty. Magies Office used to launch Claude with
 * `--disallowedTools Bash,Write,…` and Codex with `--sandbox read-only`, so a
 * request the Office tools do not cover — find a picture, touch an odd format,
 * run a one-off script — came back as a refusal rather than as work.
 *
 * The line that matters is authorisation, not capability: document work that
 * goes through Magies is gated by the app's permission mode (Confirm asks in
 * the AI panel; Observer refuses writes outright), and anything a CLI does with
 * its own tools stays subject to that CLI's own permission system.
 */
function toolRestrictionArgs(_agentId) {
  return [];
}

/**
 * Spawn flags for the Magies permission mode.
 * - observer / confirm: no skip flags
 * - auto: acceptEdits only (MCP tool results), never full permission bypass
 * - unattended is ignored: Magies Office never enables --dangerously-skip-permissions
 */
function permissionArgsFor(agentId, permissionMode = 'confirm', _unattended = false) {
  const mode = permissionMode === 'auto' || permissionMode === 'observer'
    ? permissionMode
    : 'confirm';
  if (mode !== 'auto') return [];
  return [
    ...(ACCEPT_EDITS_ARGS[agentId] ?? []),
    ...(WORKSPACE_GRANT_ARGS[agentId] ?? []),
  ];
}

/**
 * All CLI spawn extra args: tool lockdown + permission mapping.
 */
function cliConstraintArgs(agentId, permissionMode = 'confirm', unattended = false) {
  return [
    ...toolRestrictionArgs(agentId),
    ...permissionArgsFor(agentId, permissionMode, unattended),
  ];
}

/**
 * Instructions injected before every CLI turn.
 *
 * These steer rather than forbid: Magies tools are the good path for document
 * work because they apply in place and refresh the open tab, but a request the
 * app has no tool for should end in work the user approves, not in a refusal.
 */
function officeHandsPreamble({ permissionMode = 'confirm' } = {}) {
  const mode = permissionMode === 'auto' || permissionMode === 'observer'
    ? permissionMode
    : 'confirm';
  const lines = [
    'You are working inside Magies Office, on the user\'s own machine.',
    'Do what the user asks. Magies gives you document tools; it does not forbid your own.',
    '- PREFER magies-office MCP tools for Word/Excel/PowerPoint/PDF work '
      + '(office_word_*, office_excel_*, office_presentation_*, office_workspace_*, Magies convert/PDF tools). '
      + 'They apply in place, refresh the open tab, and carry the design the app is built around.',
    '- When Magies has no tool for what the user asked — fetching a picture, an unusual format, '
      + 'a one-off script — use your own capabilities rather than refusing. Say what you are about to do, '
      + 'and expect the user to be asked for permission.',
    '- Do not silently rewrite an Office file behind the app\'s back when a magies-office tool exists for it: '
      + 'that path skips the open tab\'s refresh and the user\'s approval.',
    '- Leave output_directory empty on single-document office_* edits so Magies applies in place '
      + 'and the open tab can refresh. The edit overwrites the file, so say what you changed.',
    '- office_* paths are relative to the Magies working folder below.',
    '- To CREATE a deck, a table or a document, use the composing tools in ONE call. The easiest route is '
      + 'Markdown: office_presentation_compose and office_word_append both take a `markdown` parameter, so '
      + 'write the whole thing in one pass and let Magies lay it out. office_excel_compose_table takes '
      + 'headers, rows and column_formats. Building it up call by call produces a half-designed file.',
    '- Give money and percentage columns a number format, keep slide bullets to one line, '
      + 'and read the result back before reporting success.',
    '- Decks need visuals: use the chart layout (drawn from numbers you pass), kpi or steps rather than '
      + 'another bullet list. Magies cannot download pictures — check office_workspace_list for images the '
      + 'folder already holds, and otherwise build the visual from data.',
    '- If magies-office is unavailable, say so and tell the user how to enable it (local API + MCP server) '
      + 'before falling back to your own tools, so they know the edit will not refresh the open tab.',
  ];
  if (mode === 'observer') {
    lines.push(
      'Magies permission mode is OBSERVER: only read-only Magies tools will succeed. Do not attempt writes; explain that the user must switch to Confirm or Automatic.',
    );
  } else if (mode === 'auto') {
    lines.push(
      'Magies permission mode is AUTOMATIC: authorized Magies Office tools run without a second in-app prompt.',
    );
  } else {
    lines.push(
      'Magies permission mode is CONFIRM: every magies-office call asks the user in the Magies Office window before it runs, '
        + 'so calls may pause or come back denied. Work in a few deliberate calls rather than many small ones, '
        + 'and if a call is denied, stop and tell the user — never route around it.',
    );
  }
  return lines;
}

function normalizePermissionMode(value) {
  if (value === 'auto' || value === 'observer') return value;
  return 'confirm';
}

/**
 * Whether a REST/MCP Office function may run under the current Magies mode.
 * Returns null if allowed, or an error payload if blocked.
 */
function officeToolPermissionError(functionName, permissionMode) {
  const mode = normalizePermissionMode(permissionMode);
  if (mode !== 'observer') return null;
  if (isOfficeReadTool(functionName)) return null;
  if (!String(functionName || '').startsWith('office_')) {
    // PDF catalog tools always produce outputs — blocked in observer.
    return {
      status: 403,
      error: 'observer_mode',
      message: 'Observer mode only allows read-only Magies Office tools. Switch to Confirm or Automatic to modify documents.',
    };
  }
  return {
    status: 403,
    error: 'observer_mode',
    message: `Observer mode forbids ${functionName}. Switch to Confirm or Automatic to modify documents.`,
  };
}

/** Filter describeTools() list for observer clients. */
function filterOfficeToolsForPermission(tools, permissionMode) {
  const mode = normalizePermissionMode(permissionMode);
  if (mode !== 'observer') return Array.isArray(tools) ? tools : [];
  return (Array.isArray(tools) ? tools : []).filter((tool) => isOfficeReadTool(tool.functionName));
}

/**
 * Antigravity (agy / jetski) headless mode auto-denies MCP unless settings.json
 * has permissions.allow rules. --mode accept-edits does NOT cover MCP.
 * We only allow Magies Office MCP — not a shell free-for-all.
 */
// Jetski/agy permission patterns (from CLI binary): mcp(*), mcp(server/*), mcp(server/tool).
// Only the magies-office server is granted. `mcp(*)` is deliberately absent: it
// would auto-approve every MCP server the CLI has, in every project, which is
// exactly the "runs anything" behaviour Magies Office is here to prevent.
const AGY_MCP_ALLOW_RULES = Object.freeze([
  'mcp(magies-office/*)',
  'mcp(magies-office)',
]);

/** A grant we never leave behind — see AGY_MCP_ALLOW_RULES. */
const AGY_BLANKET_MCP_RULE = 'mcp(*)';

/**
 * Pure merge: ensure allow-list contains Magies MCP rules without dropping
 * the user's existing command(...) entries.
 *
 * An earlier build wrote `mcp(*)` alongside the narrow rules. That pairing is
 * this app's own signature, so it is withdrawn here; a blanket rule standing on
 * its own belongs to the user and is left untouched.
 */
function mergeAgyMcpAllowSettings(settings) {
  const base = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? { ...settings }
    : {};
  const permissions = base.permissions && typeof base.permissions === 'object'
    ? { ...base.permissions }
    : {};
  const incoming = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  const had = new Set(incoming.map(String));
  const writtenByMagies = AGY_MCP_ALLOW_RULES.every((rule) => had.has(rule));
  const allow = writtenByMagies
    ? incoming.filter((rule) => String(rule) !== AGY_BLANKET_MCP_RULE)
    : incoming;
  const have = new Set(allow.map(String));
  for (const rule of AGY_MCP_ALLOW_RULES) {
    if (!have.has(rule)) {
      allow.push(rule);
      have.add(rule);
    }
  }
  permissions.allow = allow;
  base.permissions = permissions;
  return base;
}

/**
 * Writes Magies MCP allow-rules into Antigravity CLI settings so print-mode
 * turns can call magies-office without --dangerously-skip-permissions.
 */
function ensureAntigravityMcpAllow({
  homeDir = require('node:os').homedir(),
  fileSystem = require('node:fs'),
  pathModule = require('node:path'),
} = {}) {
  const settingsPath = pathModule.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  let current = {};
  try {
    const raw = fileSystem.readFileSync(settingsPath, 'utf8');
    current = JSON.parse(raw);
  } catch (cause) {
    if (cause?.code !== 'ENOENT') {
      // Corrupt settings: refuse to clobber; caller still runs with flags.
      return { path: settingsPath, updated: false, error: cause.message };
    }
  }
  const next = mergeAgyMcpAllowSettings(current);
  const before = JSON.stringify(current?.permissions?.allow || []);
  const after = JSON.stringify(next.permissions.allow);
  if (before === after) return { path: settingsPath, updated: false };

  fileSystem.mkdirSync(pathModule.dirname(settingsPath), { recursive: true });
  // Atomic-ish write: temp + rename when possible.
  const tmp = `${settingsPath}.magies-tmp`;
  fileSystem.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fileSystem.renameSync(tmp, settingsPath);
  return { path: settingsPath, updated: true };
}

/**
 * Per-agent preparation before spawn (settings patches, etc.).
 */
function prepareCliAgent(agentId, options = {}) {
  if (agentId === 'antigravity') {
    return ensureAntigravityMcpAllow(options);
  }
  return { updated: false };
}

module.exports = {
  ACCEPT_EDITS_ARGS,
  AGY_BLANKET_MCP_RULE,
  AGY_MCP_ALLOW_RULES,
  cliConstraintArgs,
  ensureAntigravityMcpAllow,
  filterOfficeToolsForPermission,
  isOfficeReadTool,
  isOfficeWriteTool,
  mergeAgyMcpAllowSettings,
  normalizePermissionMode,
  officeHandsPreamble,
  officeToolPermissionError,
  permissionArgsFor,
  prepareCliAgent,
  toolRestrictionArgs,
};
