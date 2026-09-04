import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const aiPanelSource = readFileSync(new URL('./AIChatPanel.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('./SettingsPanel.tsx', import.meta.url), 'utf8');
/** The AI and MCP panes live in their own component; the panel only routes to them. */
const aiSettingsSource = readFileSync(new URL('./AiSettingsSection.tsx', import.meta.url), 'utf8');
const toolCallSource = readFileSync(new URL('./AiToolCall.tsx', import.meta.url), 'utf8');
/** Providers are added, edited and keyed here. */
const providerListSource = readFileSync(new URL('./AiProviderList.tsx', import.meta.url), 'utf8');
/** Where pictures for documents come from. */
const imagesSource = readFileSync(new URL('./AiImages.tsx', import.meta.url), 'utf8');

describe('AI workspace wiring', () => {
  it('mounts an AI side panel with the active document context', () => {
    assert.match(appSource, /AIChatPanel/);
    assert.match(appSource, /activeDocument=/);
  });

  it('keeps model credentials behind the narrow secret bridge', () => {
    // A key is written per provider through setAiApiKey and never persisted in
    // settings — not on the provider object, not anywhere else.
    assert.match(providerListSource, /setAiApiKey\(value, provider\.id\)/);
    assert.match(providerListSource, /disabled=\{!apiKey \|\| !hasBridge\(\)\}/);
    assert.doesNotMatch(providerListSource, /apiKey:/);
    assert.doesNotMatch(aiSettingsSource, /update\(\{\s*ai:\s*\{[^}]*apiKey/s);
  });

  it('lets a provider be added, edited, disabled and removed', () => {
    assert.match(providerListSource, /createProviderFromPreset/);
    assert.match(providerListSource, /PROVIDER_PRESETS/);
    assert.match(providerListSource, /removeProvider/);
    // Deleting a provider clears the key it owned rather than orphaning it.
    assert.match(providerListSource, /setAiApiKey\('', provider\.id\)/);
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

  it('auto-grants the open document folder and opens AI Office write results', () => {
    assert.match(aiPanelSource, /grantAiWorkspaceForPath/);
    assert.match(aiPanelSource, /officeContext/);
    assert.match(aiPanelSource, /buildActiveOffice/);
    assert.match(aiPanelSource, /onOpenPaths/);
    assert.match(aiPanelSource, /Magies Office Output|joinWorkspacePath/);
    // Folder follows the left-hand active tab; manual pick only when none.
    assert.match(aiPanelSource, /activeDocument\?\.path/);
    assert.match(aiPanelSource, /aiWorkspaceFromDocument/);
    assert.match(aiPanelSource, /aiWorkspaceSaveFirst/);
    // Office tabs must not be mislabeled as empty PDFs.
    assert.doesNotMatch(aiPanelSource, /mime: 'application\/pdf',[\s\S]*activeDocument\.bytes/);
  });

  it('carries session memory and tool trails across chat turns', () => {
    assert.match(aiPanelSource, /sessionMemory/);
    assert.match(aiPanelSource, /rememberToolResult/);
    assert.match(aiPanelSource, /historyWithToolMemory/);
    assert.match(aiPanelSource, /emptySessionMemory/);
  });

  it('shows the generated stdio MCP client configuration', () => {
    assert.match(aiSettingsSource, /getMcpConfig/);
    assert.match(aiSettingsSource, /mcpServers/);
  });

  it('configures external MCP clients without reading encrypted configuration back', () => {
    assert.match(aiSettingsSource, /getExternalMcpStatus/);
    assert.match(aiSettingsSource, /setExternalMcpConfig/);
    assert.match(aiSettingsSource, /refreshExternalMcp/);
    assert.match(aiSettingsSource, /clearExternalMcpConfig/);
    assert.doesNotMatch(aiSettingsSource, /getExternalMcpConfig/);
    assert.doesNotMatch(settingsSource, /getExternalMcpConfig/);
    assert.doesNotMatch(settingsSource, /--warning/);
    assert.match(aiPanelSource, /approval\.details/);
  });

  it('shows workflow previews and retained tool details as an audit trail', () => {
    assert.match(aiPanelSource, /WorkflowPreview/);
    assert.match(aiPanelSource, /message\.workflow/);
    assert.match(aiPanelSource, /completed\?\.workflow/);
    assert.match(toolCallSource, /tool\.details/);
  });

  it('loads persistent task history and reuses a task only as an editable draft', () => {
    assert.match(aiPanelSource, /getAiHistory/);
    assert.match(aiPanelSource, /appendAiHistory/);
    assert.match(aiPanelSource, /clearAiHistory/);
    assert.match(aiPanelSource, /setDraft\(entry\.prompt\)/);
    assert.match(aiPanelSource, /createHistoryInput/);
    assert.doesNotMatch(aiPanelSource, /runAiTurn\([^)]*entry\.prompt/s);
  });

  it('reloads an AI-rewritten document in place instead of dropping the tab', () => {
    // Dropping the tab empties the document list, the shell falls back to the
    // welcome screen, and one AI request looks like several app restarts.
    assert.match(appSource, /replaceDocument\(held\.id, file\)/);
    assert.match(appSource, /setReloadingIds/);
    assert.match(appSource, /REOPEN_SETTLE_MS/);
    // The closed-session handler marks tabs; it must not remove them.
    assert.doesNotMatch(appSource, /onOfficeSessionsClosed[\s\S]{0,600}useApp\.setState/);
  });

  /**
   * Issue #30. Coalescing the reloads behind one timer meant a second file's
   * write cancelled the first file's reload, and the first tab was left
   * pointing at a session that had already been closed.
   */
  it('waits per file rather than behind one shared timer', () => {
    assert.match(appSource, /createReloadQueue/);
    assert.doesNotMatch(appSource, /pending = setTimeout/);
    // Reloading is a per-tab state: replacing or emptying the list takes the
    // badge off documents whose own reload is still in flight.
    assert.doesNotMatch(appSource, /setReloadingIds\(\[\]\)/);
    assert.match(appSource, /setReloadingIds\(\(current\) =>/);
  });

  /**
   * Issue #29. Opening creates the engine session first and deduplicates the
   * tab afterwards, so opening a file that is already open used to leave a
   * session — and its copy of the document — with nothing referencing it.
   */
  it('deduplicates a document before the engine is asked to open it', () => {
    assert.match(appSource, /partitionOpenPaths/);
  });

  /**
   * A tab exists only once opening has finished, so deduplicating against the
   * tab list cannot see a request still in flight. Two overlapping opens of
   * one file each created a session, and only one was ever closed — the half
   * of #29 that a tab-based check could never cover.
   */
  it('holds one claim per file while it is being opened', () => {
    assert.match(appSource, /openGuard\.claim\(fresh\)/);
    assert.match(appSource, /openInEditor\(claimed/);
    assert.match(appSource, /openGuard\.release\(claimed\)/);
  });

  /**
   * Linux distinguishes `/docs/A.docx` from `/docs/a.docx`, and this app ships
   * an AppImage and a .deb. The comparison is answered once, from the platform.
   */
  it('asks the platform whether two spellings are one file', () => {
    assert.match(appSource, /setPathCaseSensitivity\(bridge\(\)\.platform\)/);
  });

  it('deletes a single task from the history as well as clearing all of it', () => {
    assert.match(aiPanelSource, /removeAiHistoryEntry/);
    // The row disappears from the list it was removed from, not just on disk.
    assert.match(aiPanelSource, /current\.filter\(\(entry\) => entry\.id !== entryId\)/);
    assert.match(aiPanelSource, /onRemove\(entry\.id\)/);
  });

  it('shows which permission mode the next turn will run under', () => {
    // The badge reads the live setting, not the config captured when the panel
    // opened, so changing it in settings is visible without reopening.
    assert.match(aiPanelSource, /state\.settings\.ai\.permissionMode/);
    // Switchable from the panel itself, not only from Settings.
    assert.match(aiPanelSource, /permissionMode: event\.target\.value/);
    // Settings offers the same three as selectable cards.
    assert.match(aiSettingsSource, /permissionMode: entry\.id/);
    // Observer must be a real choice, not decoration: the runtime refuses on it.
    assert.match(aiSettingsSource, /'observer'/);
  });

  it('describes Terminal-style CLI hands through Magies permission mode', () => {
    assert.match(aiPanelSource, /magies-office/);
    assert.match(aiPanelSource, /permission mode gates writes|权限模式会限制写入/);
  });

  it('lets a turn be handed to an installed CLI agent, in the granted workspace only', () => {
    assert.match(aiPanelSource, /getCliAgents/);
    assert.match(aiPanelSource, /agent\.startsWith\('cli:'\)/);
    assert.match(aiPanelSource, /agent,/);
    // A CLI turn without a granted folder is refused in the renderer too, so
    // the user gets a reason rather than a main-process rejection.
    assert.match(aiPanelSource, /!workspace\?\.configured/);
  });

  it('manages review and unattended automations without exposing a direct unattended runner', () => {
    assert.match(aiPanelSource, /getAiAutomationState/);
    assert.match(aiPanelSource, /createAiAutomationRule/);
    assert.match(aiPanelSource, /setAiAutomationRuleEnabled/);
    assert.match(aiPanelSource, /deleteAiAutomationRule/);
    assert.match(aiPanelSource, /resolveAiAutomationPending/);
    assert.match(aiPanelSource, /onAiAutomationEvent/);
    assert.match(aiPanelSource, /mode: 'review' \| 'unattended'/);
    assert.match(aiPanelSource, /triggerType: 'daily' \| 'folder'/);
    assert.match(aiPanelSource, /allowedToolIds/);
    assert.doesNotMatch(aiPanelSource, /runAiUnattended/);
  });

  it('configures where document pictures come from, keyed like every other service', () => {
    // Reads what the main process will actually offer rather than echoing the
    // toggle: without a key the tool is absent, and strict local privacy
    // withdraws it whatever this pane says.
    assert.match(imagesSource, /getImageProviderStatus/);
    assert.match(imagesSource, /setImageProviderKey/);
    assert.match(imagesSource, /blockedByPrivacy/);
    assert.match(imagesSource, /apiKeyConfigured/);
    // A generator needs a model name; a stock library does not.
    assert.match(imagesSource, /requiresModel/);
    // The key goes through the bridge, never into settings.
    assert.doesNotMatch(imagesSource, /apiKey:/);

    assert.match(aiSettingsSource, /<AiImages/);
    assert.match(aiSettingsSource, /images: next/);
  });
});
