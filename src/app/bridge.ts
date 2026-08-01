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
  pipelinePresets: PipelinePreset[];
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
  state: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error';
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
}

export interface RecentDocument {
  path: string;
  name: string;
  kind: 'word' | 'sheet' | 'slide' | 'pdf';
  openedAt: number;
  modifiedAt: number;
}

export interface MagiesPdfBridge {
  platform: string;
  version: string;
  getVersion(): Promise<string>;
  isPackaged(): Promise<boolean>;
  getCatalog(): Promise<ToolMeta[]>;
  getOfficeStatus(): Promise<OfficeStatus>;
  pickLibreOfficeExecutable(): Promise<{ canceled: boolean; status: OfficeStatus }>;
  openLibreOfficeDownload(): Promise<{ opened: boolean }>;
  pickAndOpenOffice(multiple: boolean): Promise<OfficeOpenResult>;
  createAndOpenOffice(kind: OfficeCreateKind): Promise<OfficeOpenResult>;
  openOfficePaths(paths: string[]): Promise<OfficeOpenResult>;
  listRecentDocuments(): Promise<RecentDocument[]>;
  renameRecentDocument(path: string, name: string): Promise<{ path: string; name: string }>;
  trashRecentDocument(path: string): Promise<{ trashed: boolean }>;
  forgetRecentDocument(path: string): Promise<{ forgotten: boolean }>;
  pickFiles(accept: string[], multiple: boolean): Promise<PickedFile[]>;
  /** Picks supported documents without copying their contents through IPC. */
  pickDocumentPaths(multiple: boolean): Promise<string[]>;
  readFiles(paths: string[]): Promise<PickedFile[]>;
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
  onJobProgress(callback: (event: ProgressEvent) => void): () => void;
  onUpdaterStatus(callback: (status: UpdaterStatus) => void): () => void;
  getUpdaterStatus(): Promise<UpdaterStatus>;
  checkForUpdates(): Promise<boolean>;
  downloadUpdate(): Promise<boolean>;
  installUpdate(): Promise<{ success: boolean; error?: string } | boolean>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getApiStatus(): Promise<{ running: boolean; address: string; enabled: boolean }>;
  pickDirectory(): Promise<string>;
  /** Open a folder picker and load matching files (recursive by default). */
  pickFolderFiles(
    accept: string[],
    recursive: boolean,
  ): Promise<{ directory: string; files: PickedFile[]; truncated: boolean }>;
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
