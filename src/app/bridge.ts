import type { SerializedToolError } from '@core/errors.ts';
import type { JobRequest } from '@core/protocol.ts';
import type { LocalizedText, ToolMeta, ToolOutputFile } from '@core/types.ts';

/** Typed view of the `window.magiesPdf` surface exposed by `electron/preload.cjs`. */

export interface PickedFile {
  name: string;
  path: string;
  size: number;
  mime: string;
  bytes: Uint8Array;
  /**
   * Present when these bytes are a PDF rendering of an Office file rather than
   * a file the user picked. `path` is empty in that case; the source lives here.
   */
  origin?: { path: string; kind: 'word' | 'sheet' | 'slide' } | null;
  /**
   * Present when the editor engine is holding this document open. The bytes
   * then live in that session rather than in `bytes`, which is empty.
   */
  editor?: { sessionId: string; url: string; editorType?: string } | null;
}

export interface SaveResult {
  directory: string;
  written: string[];
}

export interface PipelinePreset {
  id: string;
  name: string;
  steps: Array<{ toolId: string; params: Record<string, unknown> }>;
  updatedAt: number;
}

export interface AppSettings {
  locale: 'zh' | 'en';
  theme: 'system' | 'light' | 'dark';
  /** Which palette to paint in each mode. See `src/app/theme/themes.ts`. */
  themeLight?: string;
  themeDark?: string;
  defaultOutputDirectory: string;
  onNameCollision: 'rename' | 'overwrite';
  recentToolIds: string[];
  recentDocuments: Array<{ path: string; openedAt: number }>;
  /** Default true: check feeds on launch and auto-download; install is manual. */
  autoUpdate: boolean;
  api: {
    enabled: boolean;
    port: number;
    token: string;
    allowLan: boolean;
    tlsCertPath: string;
    tlsKeyPath: string;
  };
  externalConverter: { executable: string; argumentTemplate: string; timeoutMs: number };
  office: {
    libreOfficeExecutable: string;
  };
  ai: {
    /** Configured model providers. Keys live in safeStorage, one per provider. */
    providers: AiProvider[];
    activeProviderId: string;
    maxSteps: number;
    /**
     * 'observer' refuses them outright, 'confirm' asks, 'auto' runs them.
     * Applies to every tool call that writes a file or leaves the machine.
     */
    permissionMode?: 'observer' | 'confirm' | 'auto';
    /** Per-CLI model and effort, keyed by agent id. */
    cliModels?: Record<string, { model?: string; effort?: string; unattended?: boolean }>;
    /** Refuse any turn that would leave this machine. */
    strictLocalPrivacy?: boolean;
    webSearch?: { enabled: boolean; provider: string; endpoint: string };
    /** Where document pictures come from. Its key lives in safeStorage. */
    images?: { enabled: boolean; provider: string; endpoint: string; model: string };
    /** Pre-list shape, migrated on read in the main process. Do not write. */
    baseUrl?: string;
    model?: string;
  };
  pipelinePresets: PipelinePreset[];
  onboardingComplete?: boolean;
}

export interface JobResult {
  files: ToolOutputFile[];
  data?: unknown;
  summary?: LocalizedText;
}

export interface ProgressEvent {
  jobId: string;
  fraction: number;
  message?: LocalizedText;
}

export interface UpdaterStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'current'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'error';
  message?: string;
  version?: string;
}

export type OfficeCreateKind = 'word' | 'sheet' | 'slide';

export interface OfficeStatus {
  libreOffice: { available: boolean; executable: string };
}

export interface OfficeOpenResult {
  opened: string[];
  canceled: boolean;
  /**
   * The opened documents, rendered to PDF for the viewer. Each one carries its
   * source under `origin` and no path of its own — see `documents.ts`.
   */
  files: PickedFile[];
}

export interface RecentDocument {
  path: string;
  name: string;
  kind: 'word' | 'sheet' | 'slide' | 'pdf';
  openedAt: number;
  modifiedAt: number;
}

export interface AiProvider {
  id: string;
  /** Which vendor preset it came from, or 'custom'. */
  providerId: string;
  name: string;
  baseUrl: string;
  model: string;
  /** '' omits the field; reasoning models take low / medium / high. */
  reasoningEffort?: '' | 'low' | 'medium' | 'high';
  enabled: boolean;
}

/**
 * What the main process reports about the configured providers. `baseUrl`,
 * `model` and `apiKeyConfigured` at the top level are the resolved view of the
 * active provider — what the next turn would actually use.
 */
export interface AiConfig {
  providers: Array<AiProvider & { apiKeyConfigured: boolean }>;
  activeProviderId: string;
  maxSteps: number;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
}

/** Where pictures for documents come from — a stock library, or generation. */
export interface ImageProviderStatus {
  presets: Array<{
    id: string;
    name: string;
    kind: 'search' | 'generate';
    endpoint: string;
    defaultModel?: string;
    requiresApiKey: boolean;
    requiresModel: boolean;
    hint: LocalizedText;
  }>;
  enabled: boolean;
  provider: string;
  endpoint: string;
  model: string;
  apiKeyConfigured: boolean;
  blockedByPrivacy: boolean;
  /** What 'auto' resolved to, or null when the model provider serves no images. */
  followsModelProvider: { endpoint: string; model: string } | null;
}

export interface AiWorkspaceStatus {
  configured: boolean;
  path: string;
}

/** What the AI knows about the document open in this window. */
export interface AiActiveOffice {
  name: string;
  /** Absolute path when saved; empty when not on disk yet. */
  path: string;
  /** Path relative to the granted workspace, when inside it. */
  relativePath: string;
  kind: 'word' | 'sheet' | 'slide' | 'pdf';
  sessionId?: string;
  dirty: boolean;
  inWorkspace: boolean;
  saved: boolean;
}

/** Working memory carried across turns in one AI chat session. */
export interface AiSessionMemory {
  focusPath: string;
  recentWrites: Array<{ path: string; toolId: string; at: number }>;
  recentTools: Array<{ toolId: string; ok: boolean; detail: string; at: number }>;
  notes: string[];
}

/** A pending Confirm-mode question about an Office tool from outside this window. */
export interface OfficeToolApproval {
  approvalId: string;
  functionName: string;
  toolId: string;
  /** Workspace-relative path the call names, when it names one. */
  path: string;
}

export interface AiOfficeContext {
  workspacePath: string;
  activeOffice: AiActiveOffice | null;
  /** Prior Office writes / tool outcomes for multi-turn follow-ups. */
  sessionMemory?: AiSessionMemory | null;
}

export interface AiArtifact extends ToolOutputFile {
  id: string;
}

export interface AiHistoryTool {
  toolId: string;
  toolName?: LocalizedText;
}

export interface AiHistoryEntry {
  id: string;
  createdAt: number;
  prompt: string;
  response: string;
  success: boolean;
  workflow: AiHistoryTool[];
  tools: Array<AiHistoryTool & { status: 'done' | 'error' }>;
  artifacts: Array<{ name: string }>;
}

export type AiHistoryInput = Omit<AiHistoryEntry, 'id' | 'createdAt'>;

export type AiAutomationMode = 'review' | 'unattended';

export type AiAutomationTrigger =
  | { type: 'daily'; at: string }
  | { type: 'folder'; extensions: string[] };

export interface AiAutomationRuleInput {
  name: string;
  prompt: string;
  mode: AiAutomationMode;
  trigger: AiAutomationTrigger;
  allowedToolIds: string[];
  maxRunsPerDay: number;
  retryLimit: number;
}

export interface AiAutomationRule extends AiAutomationRuleInput {
  id: string;
  enabled: boolean;
  failureCount: number;
  lastError: string;
  runDate: string;
  runCount: number;
  lastDailyDate: string;
  createdAt: number;
  updatedAt: number;
}

export interface AiAutomationPending {
  id: string;
  ruleId: string;
  createdAt: number;
  prompt: string;
  sourcePath: string;
}

export interface AiAutomationRun {
  id: string;
  ruleId: string;
  createdAt: number;
  status: 'queued' | 'success' | 'error';
  attempts: number;
  message: string;
  sourcePath: string;
}

export interface AiAutomationState {
  rules: AiAutomationRule[];
  pending: AiAutomationPending[];
  runs: AiAutomationRun[];
  tools: AiHistoryTool[];
}

export interface AiAutomationEvent {
  type: 'pending' | 'completed' | 'failed' | 'run_event' | 'engine_error';
  ruleId?: string;
  message?: string;
}

interface AiEventBase {
  requestId: string;
}

export type AiEvent =
  | (AiEventBase & { type: 'model_start'; step: number })
  | (AiEventBase & { type: 'assistant_delta'; delta: string })
  | (AiEventBase & { type: 'assistant_done'; content: string })
  | (AiEventBase & {
      type: 'workflow_preview';
      steps: Array<{
        callId: string;
        toolId: string;
        toolName?: LocalizedText;
        details?: string;
      }>;
    })
  | (AiEventBase & {
      type: 'tool_start';
      callId: string;
      toolId: string;
      toolName: LocalizedText;
      inputFileNames: string[];
      details?: string;
    })
  | (AiEventBase & {
      type: 'tool_progress';
      callId: string;
      toolId: string;
      fraction: number;
      message?: LocalizedText;
    })
  | (AiEventBase & {
      type: 'tool_result';
      callId: string;
      toolId: string;
      ok: boolean;
      error?: string;
      files?: AiArtifact[];
      /** Office automation payload (e.g. { written, source }). */
      result?: unknown;
      summary?: LocalizedText;
      data?: unknown;
    })
  | (AiEventBase & {
      type: 'approval_required';
      approvalId: string;
      toolId: string;
      toolName: LocalizedText;
      inputFileNames?: string[];
      details?: string;
    })
  | (AiEventBase & { type: 'approval_cleared'; approvalId: string });

export interface AiTurnRequest {
  requestId: string;
  prompt: string;
  /**
   * Empty runs the built-in model runtime; `cli:<id>` hands the turn to that
   * installed CLI, which executes it in the granted Office workspace.
   */
  agent?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  locale: 'zh' | 'en';
  files: Array<{
    id: string;
    name: string;
    /** Where it lives on disk, when it has been saved. A CLI agent needs this. */
    path?: string;
    mime: string;
    bytes: Uint8Array;
    password?: string;
  }>;
  /** Built-in runtime: open document + granted folder for Office tools. */
  officeContext?: AiOfficeContext;
}

export interface AiTurnResult {
  message: string;
  files: ToolOutputFile[];
}

export interface McpClientConfig {
  ready: boolean;
  reason: string;
  config: {
    mcpServers: Record<string, {
      command: string;
      args: string[];
      env: Record<string, string>;
    }>;
  };
}

export interface WebSearchStatus {
  presets: Array<{
    id: string;
    name: string;
    requiresApiKey: boolean;
    hint: { zh: string; en: string };
  }>;
  enabled: boolean;
  provider: string;
  endpoint: string;
  apiKeyConfigured: boolean;
  /** Strict local privacy withdraws the tool regardless of this configuration. */
  blockedByPrivacy: boolean;
}

/** A coding-agent CLI found on this machine. */
export interface CliAgentStatus {
  id: string;
  name: string;
  command: string;
  /**
   * How this agent can be given the MCP server: by rewriting its JSON config,
   * by running its own `mcp add`, or not at all.
   */
  format: 'json' | 'command' | 'none';
  /** Whether this app knows how to run a turn through it. */
  runnable: boolean;
  configPath: string;
  path: string;
  installed: boolean;
  version: string;
  /** Whether our MCP server is already in that agent's configuration. */
  mcpInstalled: boolean;
  /** The models this CLI accepts, and the effort levels it understands. */
  models: Array<{ id: string; name: string; description?: string }>;
  effortLevels: string[];
}

export interface CliMcpInstallResult {
  ok: boolean;
  agentId: string;
  path: string;
  /** Present when the agent is configured by hand; paste this into its config. */
  snippet: string;
  /** Why the automatic attempt failed, when it did. */
  error: string;
}

export type ExternalMcpServerState = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ExternalMcpStatus {
  configured: boolean;
  servers: Array<{
    id: string;
    transport: 'stdio' | 'http' | 'unknown';
    enabled: boolean;
    state: ExternalMcpServerState;
    toolCount: number;
    error: string;
  }>;
}

export interface MagiesPdfBridge {
  platform: string;
  version: string;
  getVersion(): Promise<string>;
  isPackaged(): Promise<boolean>;
  getCatalog(): Promise<ToolMeta[]>;
  /** Creates a blank document on disk. Opening it is a separate step. */
  createBlankOffice(kind: OfficeCreateKind): Promise<{ created: string; canceled: boolean }>;
  /**
   * Opens Office documents in the embedded editor. Bytes stay in the engine.
   * `uiTheme` is an ONLYOFFICE id: theme-system | theme-white | theme-night.
   */
  openInEditor(
    paths: string[],
    options?: { uiTheme?: 'theme-system' | 'theme-white' | 'theme-night' | string },
  ): Promise<PickedFile[]>;
  /**
   * Starts the loopback editor host and lists static assets to pull into the
   * Chromium HTTP cache before the user opens a document.
   */
  warmEditor(): Promise<{ origin: string; url?: string; prefetch: string[] }>;
  focusEditor(sessionId: string): Promise<{ focused: boolean }>;
  /** `bytes` is the engine's own binary, base64 encoded. */
  saveEditor(sessionId: string, bytes: string): Promise<{ path: string; name: string }>;
  /**
   * Asks where a save-as should land and remembers it; the save that follows
   * goes there instead of over the original. The extension decides the format.
   */
  pickEditorSaveAsTarget(sessionId: string, name: string, kind?: 'pdf'): Promise<{ path: string } | null>;
  /**
   * The engine's "Save copy as": the file is already converted and uploaded.
   * Opens a save dialog and writes those bytes (does not re-run the engine).
   */
  saveEditorExport(sessionId: string, name: string): Promise<{ path: string; name: string } | null>;
  closeEditor(sessionId: string): Promise<{ closed: string }>;
  /**
   * Mirrors this tab's unsaved state into the main process, where an AI write
   * uses it to refuse a document the user is still editing.
   */
  /** Tells the main process which documents are unsaved, for the close guard. */
  reportUnsaved(names: string[]): Promise<unknown>;
  /** Called when the window is closing and everything must be written first. */
  onSaveAllRequested(
    handler: () => Promise<{ saved: boolean; message?: string }>,
  ): () => void;
  setEditorModified(sessionId: string, modified: boolean): Promise<unknown>;
  /** Fires once the engine's document has been written back to disk. */
  onEditorSaved(
    handler: (payload: { sessionId: string; path?: string; name?: string; exportedTo?: string }) => void,
  ): () => void;
  /** Fires when a save could not be written. The document is still unsaved. */
  onEditorSaveFailed(
    handler: (payload: { sessionId: string; message: string }) => void,
  ): () => void;
  onOfficeSessionsClosed(
    handler: (payload: { sessions: Array<{ sessionId: string; path: string }> }) => void,
  ): () => void;
  onOfficeDocumentApplied(
    handler: (payload: { path: string }) => void,
  ): () => void;
  listRecentDocuments(): Promise<RecentDocument[]>;
  renameRecentDocument(path: string, name: string): Promise<{ path: string; name: string }>;
  trashRecentDocument(path: string): Promise<{ trashed: boolean }>;
  forgetRecentDocument(path: string): Promise<{ forgotten: boolean }>;
  pickFiles(accept: string[], multiple: boolean): Promise<PickedFile[]>;
  /** Picks supported documents without copying their contents through IPC. */
  pickDocumentPaths(multiple: boolean): Promise<string[]>;
  readFiles(paths: string[]): Promise<PickedFile[]>;
  /**
   * Picks a program to run, by path. Nothing is read, and the path gains no
   * read or write rights — it is passed to the converter, not opened here.
   */
  pickExecutable(): Promise<{ path: string; problem?: string } | null>;
  pathForFile(file: File): string;
  saveOutputs(
    files: ToolOutputFile[],
    options?: { directory?: string },
  ): Promise<SaveResult | null>;
  saveOutputAs(file: ToolOutputFile): Promise<SaveResult | null>;
  /** Overwrites a file the app already opened. Rejects any other path. */
  writeToPath(targetPath: string, bytes: Uint8Array): Promise<SaveResult>;
  revealPath(path: string): Promise<boolean>;
  /** Documents the OS asked the app to open. Returns an unsubscribe function. */
  onOpenFiles(callback: (paths: string[]) => void): () => void;
  runJob(request: JobRequest): Promise<JobResult>;
  cancelJob(jobId: string): Promise<boolean>;
  getAiConfig(): Promise<AiConfig>;
  setAiApiKey(
    apiKey: string,
    providerId?: string,
  ): Promise<{ providerId: string; apiKeyConfigured: boolean }>;
  runAiTurn(request: AiTurnRequest): Promise<AiTurnResult>;
  cancelAiTurn(requestId: string): Promise<boolean>;
  respondAiApproval(requestId: string, approvalId: string, approved: boolean): Promise<boolean>;
  getAiWorkspaceStatus(): Promise<AiWorkspaceStatus>;
  pickAiWorkspace(): Promise<AiWorkspaceStatus>;
  /** Grants the parent folder of a saved document as the AI Office workspace. */
  grantAiWorkspaceForPath(documentPath: string): Promise<AiWorkspaceStatus>;
  clearAiWorkspace(): Promise<AiWorkspaceStatus>;
  getAiHistory(): Promise<AiHistoryEntry[]>;
  appendAiHistory(entry: AiHistoryInput): Promise<AiHistoryEntry>;
  /** Deletes one task. False when that id is no longer in the history. */
  removeAiHistoryEntry(id: string): Promise<boolean>;
  /**
   * An Office tool call that came in over the local API / magies-office MCP and
   * needs the user's word before it runs (Confirm mode).
   */
  onOfficeToolApproval(handler: (request: OfficeToolApproval) => void): () => void;
  /** That question is off the table — answered elsewhere, or it timed out. */
  onOfficeToolApprovalCleared(handler: (payload: { approvalId: string }) => void): () => void;
  respondOfficeToolApproval(
    approvalId: string,
    decision: 'once' | 'session' | 'deny',
  ): Promise<boolean>;
  clearAiHistory(): Promise<boolean>;
  getAiAutomationState(): Promise<AiAutomationState>;
  createAiAutomationRule(rule: AiAutomationRuleInput): Promise<AiAutomationState>;
  setAiAutomationRuleEnabled(ruleId: string, enabled: boolean): Promise<AiAutomationState>;
  deleteAiAutomationRule(ruleId: string): Promise<AiAutomationState>;
  resolveAiAutomationPending(pendingId: string): Promise<AiAutomationState>;
  onAiEvent(callback: (event: AiEvent) => void): () => void;
  onAiAutomationEvent(callback: (event: AiAutomationEvent) => void): () => void;
  onJobProgress(callback: (event: ProgressEvent) => void): () => void;
  onUpdaterStatus(callback: (status: UpdaterStatus) => void): () => void;
  getUpdaterStatus(): Promise<UpdaterStatus>;
  checkForUpdates(): Promise<boolean>;
  downloadUpdate(): Promise<boolean>;
  installUpdate(): Promise<{ success: boolean; error?: string } | boolean>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getApiStatus(): Promise<{ running: boolean; address: string; enabled: boolean }>;
  getMcpConfig(): Promise<McpClientConfig>;
  getWebSearchStatus(): Promise<WebSearchStatus>;
  setWebSearchKey(apiKey: string): Promise<{ apiKeyConfigured: boolean }>;
  getImageProviderStatus(): Promise<ImageProviderStatus>;
  setImageProviderKey(apiKey: string): Promise<{ apiKeyConfigured: boolean }>;
  getCliAgents(): Promise<CliAgentStatus[]>;
  installCliMcp(agentId: string): Promise<CliMcpInstallResult>;
  /** Asks the CLI for its current models, falling back to the shipped list. */
  getCliModels(agentId: string): Promise<Array<{ id: string; name: string; description?: string }>>;
  getExternalMcpStatus(): Promise<ExternalMcpStatus>;
  setExternalMcpConfig(config: string): Promise<ExternalMcpStatus>;
  refreshExternalMcp(): Promise<ExternalMcpStatus>;
  clearExternalMcpConfig(): Promise<ExternalMcpStatus>;
  pickDirectory(): Promise<string>;
  /** Open a folder picker and load matching files (recursive by default). */
  pickFolderFiles(
    accept: string[],
    recursive: boolean,
  ): Promise<{ directory: string; files: PickedFile[]; truncated: boolean }>;
  /**
   * Prints a document's bytes, not the window. Resolves `printed: false` with
   * `reason: 'cancelled'` when the user dismisses the print dialog.
   */
  printPdf(
    bytes: Uint8Array,
    name: string,
    /** How many pages the viewer laid out, so a blank render can be told apart. */
    pages: number,
  ): Promise<{ printed: boolean; reason?: string }>;
}

declare global {
  interface Window {
    magiesPdf?: MagiesPdfBridge;
  }
}

/**
 * The bridge is absent when the renderer is opened in a plain browser (e.g. `vite
 * preview`). Failing loudly at the call site beats a cascade of undefined errors.
 */
export function bridge(): MagiesPdfBridge {
  const api = window.magiesPdf;
  if (!api) {
    throw new Error('MagiesPdf desktop bridge is unavailable — run the app via Electron.');
  }
  return api;
}

export function hasBridge(): boolean {
  return Boolean(window.magiesPdf);
}

export function isToolError(value: unknown): value is SerializedToolError {
  return typeof value === 'object' && value !== null && '__toolError' in value;
}
