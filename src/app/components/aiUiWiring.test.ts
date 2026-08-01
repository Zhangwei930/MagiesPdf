import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const aiPanelSource = readFileSync(new URL('./AIChatPanel.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./SettingsPanel.tsx', import.meta.url), 'utf8');

describe('AI workspace wiring', () => {
  it('mounts an AI side panel with the active document context', () => {
    assert.match(appSource, /AIChatPanel/);
    assert.match(appSource, /activeDocument=/);
  });

  it('keeps model credentials behind the narrow secret bridge', () => {
    assert.match(settingsSource, /setAiApiKey/);
    assert.doesNotMatch(settingsSource, /update\(\{\s*ai:\s*\{[^}]*apiKey/s);
    assert.match(settingsSource, /disabled=\{!apiKey \|\| !hasBridge\(\)\}/);
  });

  it('surfaces model configuration load failures from the send action', () => {
    assert.match(aiPanelSource, /try \{\s*const currentConfig = await bridge\(\)\.getAiConfig\(\)/s);
  });

  it('lets the user grant and clear a local Office workspace', () => {
    assert.match(aiPanelSource, /getAiWorkspaceStatus/);
    assert.match(aiPanelSource, /pickAiWorkspace/);
    assert.match(aiPanelSource, /clearAiWorkspace/);
    assert.match(aiPanelSource, /aiWorkspaceChoose/);
    assert.match(aiPanelSource, /aiWorkspaceClear/);
  });

  it('shows the generated stdio MCP client configuration', () => {
    assert.match(settingsSource, /getMcpConfig/);
    assert.match(settingsSource, /mcpServers/);
  });

  it('configures external MCP clients without reading encrypted configuration back', () => {
    assert.match(settingsSource, /getExternalMcpStatus/);
    assert.match(settingsSource, /setExternalMcpConfig/);
    assert.match(settingsSource, /refreshExternalMcp/);
    assert.match(settingsSource, /clearExternalMcpConfig/);
    assert.doesNotMatch(settingsSource, /getExternalMcpConfig/);
    assert.doesNotMatch(settingsSource, /--warning/);
    assert.match(aiPanelSource, /approval\.details/);
  });

  it('shows workflow previews and retained tool details as an audit trail', () => {
    assert.match(aiPanelSource, /WorkflowPreview/);
    assert.match(aiPanelSource, /message\.workflow/);
    assert.match(aiPanelSource, /completed\?\.workflow/);
    assert.match(aiPanelSource, /tool\.details/);
  });
});
