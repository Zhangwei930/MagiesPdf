'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AGY_MCP_ALLOW_RULES,
  cliConstraintArgs,
  ensureAntigravityMcpAllow,
  filterOfficeToolsForPermission,
  isOfficeReadTool,
  isOfficeWriteTool,
  mergeAgyMcpAllowSettings,
  officeHandsPreamble,
  officeToolPermissionError,
  permissionArgsFor,
  toolRestrictionArgs,
} = require('./cliPolicy.cjs');

describe('cliPolicy', () => {
  it('classifies Office read vs write tools', () => {
    assert.equal(isOfficeReadTool('office_excel_read'), true);
    assert.equal(isOfficeWriteTool('office_excel_write'), true);
    assert.equal(isOfficeWriteTool('office_excel_read'), false);
    assert.equal(isOfficeWriteTool('convert.pdf-to-docx'), false);
  });

  it('grants a CLI its tools in automatic mode, scoped to the granted folder', () => {
    // Confirm and observer leave the CLI exactly as the user configured it;
    // Magies asks in the AI panel for anything going through its own tools.
    assert.deepEqual(permissionArgsFor('claude', 'confirm', false), []);
    assert.deepEqual(permissionArgsFor('claude', 'observer', false), []);

    const claude = permissionArgsFor('claude', 'auto', false).join(' ');
    assert.match(claude, /--permission-mode acceptEdits/);
    assert.match(claude, /--allowedTools/);
    assert.match(claude, /Bash/);

    // Codex works inside its working directory — which is the granted folder —
    // rather than being handed the whole machine.
    const codex = permissionArgsFor('codex', 'auto', false).join(' ');
    assert.match(codex, /--sandbox workspace-write/);
    assert.match(codex, /--ask-for-approval never/);

    // The machine-wide bypass is never what a folder grant buys.
    for (const agent of ['claude', 'codex', 'gemini', 'antigravity', 'cursor']) {
      const args = permissionArgsFor(agent, 'auto', true).join(' ');
      assert.doesNotMatch(args, /dangerously|--yolo|danger-full-access/i, agent);
    }
  });

  it('never strips a CLI of its own tools', () => {
    // A request Magies has no tool for used to come back as a refusal. What
    // gates the work is the permission mode, not a missing capability.
    for (const agent of ['claude', 'codex', 'grok', 'antigravity']) {
      assert.deepEqual(toolRestrictionArgs(agent), [], agent);
    }
  });

  it('maps auto mode to acceptEdits and never to a shell bypass', () => {
    const args = cliConstraintArgs('claude', 'auto', true).join(' ');
    assert.match(args, /acceptEdits/);
    assert.doesNotMatch(args, /dangerously-skip-permissions/);
    assert.doesNotMatch(args, /--disallowedTools/);
  });

  it('injects Magies-hands instructions and observer warning', () => {
    const auto = officeHandsPreamble({ permissionMode: 'auto' }).join('\n');
    assert.match(auto, /magies-office MCP/i);
    assert.match(auto, /AUTOMATIC/);
    // Preference, not prohibition: the agent may use its own tools for what
    // Magies does not cover, and says so before it does.
    assert.match(auto, /PREFER magies-office/);
    assert.match(auto, /use your own capabilities rather than refusing/);
    assert.doesNotMatch(auto, /FORBIDDEN/);
    assert.doesNotMatch(auto, /HARD CONSTRAINTS/);

    const observer = officeHandsPreamble({ permissionMode: 'observer' }).join('\n');
    assert.match(observer, /OBSERVER/i);
    assert.match(observer, /read-only/i);

    // Confirm now really does prompt per call — the agent is told so it does
    // not read a pause or a denial as the tool being broken.
    const confirm = officeHandsPreamble({ permissionMode: 'confirm' }).join('\n');
    assert.match(confirm, /CONFIRM/);
    assert.match(confirm, /asks the user/i);
    assert.match(confirm, /denied/i);
  });

  it('blocks write tools in observer mode for the REST/MCP gate', () => {
    assert.equal(officeToolPermissionError('office_excel_read', 'observer'), null);
    assert.equal(officeToolPermissionError('office_excel_write', 'auto'), null);
    const blocked = officeToolPermissionError('office_excel_write', 'observer');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.error, 'observer_mode');

    const catalog = officeToolPermissionError('convert.pdf-to-docx', 'observer');
    assert.equal(catalog.status, 403);
  });

  it('filters Office tool discovery for observer', () => {
    const tools = [
      { functionName: 'office_excel_read' },
      { functionName: 'office_excel_write' },
      { functionName: 'office_word_replace' },
    ];
    assert.deepEqual(
      filterOfficeToolsForPermission(tools, 'observer').map((t) => t.functionName),
      ['office_excel_read'],
    );
    assert.equal(filterOfficeToolsForPermission(tools, 'auto').length, 3);
  });

  it('merges Magies MCP allow rules into Antigravity settings without dropping commands', () => {
    const merged = mergeAgyMcpAllowSettings({
      permissions: { allow: ['command(ls)', 'mcp(magies-office)'] },
    });
    assert.ok(merged.permissions.allow.includes('command(ls)'));
    assert.ok(merged.permissions.allow.includes('mcp(magies-office)'));
    for (const rule of AGY_MCP_ALLOW_RULES) {
      assert.ok(merged.permissions.allow.includes(rule), rule);
    }
    // Idempotent
    const again = mergeAgyMcpAllowSettings(merged);
    assert.equal(
      again.permissions.allow.filter((r) => r === 'mcp(magies-office)').length,
      1,
    );
  });

  it('writes Antigravity settings so headless MCP is allowed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'magies-agy-'));
    const dir = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['command(date)'] },
    }));
    const result = ensureAntigravityMcpAllow({ homeDir: home });
    assert.equal(result.updated, true);
    const saved = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    assert.ok(saved.permissions.allow.includes('command(date)'));
    assert.ok(saved.permissions.allow.includes('mcp(magies-office/*)'));
    // Never a blanket MCP grant: that would auto-approve every other MCP
    // server this CLI has, in every project, not just Magies Office.
    assert.equal(saved.permissions.allow.includes('mcp(*)'), false);
    // Second call no-ops
    assert.equal(ensureAntigravityMcpAllow({ homeDir: home }).updated, false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('withdraws a blanket mcp(*) grant an earlier build wrote', () => {
    const merged = mergeAgyMcpAllowSettings({
      permissions: { allow: ['command(ls)', 'mcp(magies-office)', 'mcp(magies-office/*)', 'mcp(*)'] },
    });
    assert.equal(merged.permissions.allow.includes('mcp(*)'), false);
    assert.ok(merged.permissions.allow.includes('command(ls)'));
    assert.ok(merged.permissions.allow.includes('mcp(magies-office/*)'));
  });

  it('leaves a blanket grant alone when Magies did not write the narrow rules', () => {
    // Only our own signature is withdrawn — a rule the user set themselves,
    // without the Magies rules beside it, is theirs to keep.
    const merged = mergeAgyMcpAllowSettings({
      permissions: { allow: ['mcp(*)'] },
    });
    assert.ok(merged.permissions.allow.includes('mcp(*)'));
  });
});
