import { create } from 'zustand';
import type { SerializedToolError } from '@core/errors.ts';
import type { LocalizedText, ToolMeta } from '@core/types.ts';
import {
  bridge,
  hasBridge,
  isToolError,
  type AppSettings,
  type JobResult,
  type MagiesPdfBridge,
  type PickedFile,
} from './bridge.ts';
import { loadCatalog } from './catalog.ts';
import * as docs from './documents.ts';
import type { DocumentState } from './documents.ts';
import type { Locale } from './i18n.ts';
import { classifyOutput } from './toolApply.ts';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobEntry {
  id: string;
  toolId: string;
  toolName: LocalizedText;
  fileNames: string[];
  status: JobStatus;
  fraction: number;
  message?: LocalizedText;
  result?: JobResult;
  error?: SerializedToolError;
  startedAt: number;
  finishedAt?: number;
  savedTo?: string;
}

interface AppState {
  ready: boolean;
  /** Set when start-up failed. The shell shows this instead of spinning forever. */
  startupError: string;
  settings: AppSettings;
  locale: Locale;
  /** Resolved theme actually applied to <html>, after following the system when asked. */
  darkMode: boolean;

  jobs: JobEntry[];
  /** Tool ids most recently run, newest first. */
  recentToolIds: string[];

  /**
   * Open documents, in tab order. Editing lives here rather than in the Viewer
   * so that a tool run and a rotate land in the same history, and so a
   * document survives being switched away from.
   */
  documents: DocumentState[];
  activeDocumentId: string | null;

  /** Opens a file, or focuses the tab already holding it. Returns its id. */
  openDocument(file: PickedFile): string;
  closeDocument(id: string): void;
  setActiveDocument(id: string): void;
  editDocument(id: string, bytes: Uint8Array): void;
  undoDocument(id: string): void;
  redoDocument(id: string): void;
  setDocumentPassword(id: string, password: string): void;
  /** ⌘S. Writes over the file the document came from, or asks where to put it. */
  saveDocument(id: string): Promise<void>;
  setEngineModified(id: string, modified: boolean): void;
  /** ⌘S on an engine-held document. Never a direct write — see documents.ts. */
  requestEngineSave(id: string): Promise<void>;
  /** Set while a hosted document has been asked for; the frame watches it. */
  engineSaveRequest: { id: string; at: number } | null;
  engineSaved(payload: { sessionId: string; path?: string; name?: string }): void;
  saveDocumentAs(id: string): Promise<void>;
  /**
   * Runs a tool over an open document. A single PDF coming back replaces the
   * document and joins its undo history; anything else is handed back for the
   * caller to offer for saving, leaving the document untouched.
   */
  applyToolToDocument(
    id: string,
    tool: ToolMeta,
    params: Record<string, unknown>,
    /** Extra inputs after the open PDF (merge, overlay, …). */
    extraFiles?: Array<{ name: string; bytes: Uint8Array; mime: string }>,
  ): Promise<JobResult>;

  initialize(): Promise<void>;
  setLocale(locale: Locale): Promise<void>;
  setTheme(theme: AppSettings['theme']): Promise<void>;
  updateSettings(patch: Partial<AppSettings>): Promise<void>;

  runTool(tool: ToolMeta, files: PickedFile[], params: Record<string, unknown>): Promise<string>;
  cancelJob(jobId: string): Promise<void>;
  clearFinishedJobs(): void;
  markJobSaved(jobId: string, directory: string): void;
}

const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh',
  theme: 'system',
  defaultOutputDirectory: '',
  onNameCollision: 'rename',
  recentToolIds: [],
  recentDocuments: [],
  /** Check + auto-download on launch; install still requires a restart click. */
  autoUpdate: true,
  api: {
    enabled: false,
    port: 8737,
    token: '',
    allowLan: false,
    tlsCertPath: '',
    tlsKeyPath: '',
  },
  externalConverter: { executable: '', argumentTemplate: '', timeoutMs: 120000 },
  office: { libreOfficeExecutable: '' },
  ai: { baseUrl: 'http://127.0.0.1:11434/v1', model: '', maxSteps: 6 },
  pipelinePresets: [],
};

const RECENT_LIMIT = 8;

function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveDark(theme: AppSettings['theme']): boolean {
  return theme === 'system' ? prefersDark() : theme === 'dark';
}

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
}

/** Replaces one document in the list, leaving the others' identities alone. */
function mapDocument(
  documents: readonly DocumentState[],
  id: string,
  change: (document: DocumentState) => DocumentState,
): DocumentState[] {
  return documents.map((document) => (document.id === id ? change(document) : document));
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  startupError: '',
  settings: DEFAULT_SETTINGS,
  locale: DEFAULT_SETTINGS.locale,
  darkMode: false,
  jobs: [],
  recentToolIds: [],
  documents: [],
  activeDocumentId: null,
  engineSaveRequest: null,

  openDocument(file) {
    const incoming = docs.createDocument(file);
    const { documents, activeId } = docs.openDocument(get().documents, incoming);
    set({ documents, activeDocumentId: activeId });
    return activeId;
  },

  closeDocument(id) {
    // An engine-held document has a session and a work directory behind it;
    // dropping the tab without telling the engine would leave both running and
    // a copy of the user's document in temp.
    const held = get().documents.find((d) => d.id === id)?.editor;
    if (held) void bridge().closeEditor(held.sessionId).catch(() => {});

    set((state) => ({
      documents: docs.closeDocument(state.documents, id),
      activeDocumentId: docs.nextActiveId(state.documents, id, state.activeDocumentId),
    }));
  },

  setEngineModified(id, modified) {
    set((state) => ({
      documents: mapDocument(state.documents, id, (d) => docs.setEngineModified(d, modified)),
    }));
  },

  setActiveDocument(id) {
    // The engine serves images by the key they had in the open document, with
    // nothing to say which document that was, so it has to be told which one is
    // in front.
    const held = get().documents.find((d) => d.id === id)?.editor;
    if (held) void bridge().focusEditor(held.sessionId).catch(() => {});
    set({ activeDocumentId: id });
  },

  editDocument(id, bytes) {
    set((state) => ({ documents: mapDocument(state.documents, id, (d) => docs.applyEdit(d, bytes)) }));
  },

  undoDocument(id) {
    set((state) => ({ documents: mapDocument(state.documents, id, docs.undo) }));
  },

  redoDocument(id) {
    set((state) => ({ documents: mapDocument(state.documents, id, docs.redo) }));
  },

  setDocumentPassword(id, password) {
    set((state) => ({
      documents: mapDocument(state.documents, id, (d) => docs.setPassword(d, password)),
    }));
  },

  async saveDocument(id) {
    const document = get().documents.find((d) => d.id === id);
    if (!document) return;

    switch (docs.saveTarget(document)) {
      case 'prompt':
        // Nothing on disk to write over — a tool result held in memory, or a
        // rendering that must not be written back over its source.
        await get().saveDocumentAs(id);
        return;

      case 'engine':
        // The bytes are the engine's. Writing this document's own empty array
        // to its path would truncate the user's file, so the request goes to
        // the engine and the frame answers it with what it is holding.
        await get().requestEngineSave(id);
        return;

      default:
        await bridge().writeToPath(document.path, document.bytes);
        set((state) => ({ documents: mapDocument(state.documents, id, (d) => docs.markSaved(d, '')) }));
    }
  },

  /**
   * ⌘S on an engine-held document.
   *
   * The bytes are the engine's, so this only asks. The frame passes the request
   * to the engine, the engine posts its document back to the main process, and
   * the save happens there — `office:editorSaved` says when it is done.
   */
  async requestEngineSave(id) {
    const document = get().documents.find((d) => d.id === id);
    if (!document?.editor) return;
    set({ engineSaveRequest: { id, at: Date.now() } });
  },

  engineSaved(payload) {
    const sessionId = payload.sessionId;
    set((state) => ({
      documents: state.documents.map((d) =>
        d.editor?.sessionId === sessionId
          ? docs.applyEngineSaved(d, { path: payload.path, name: payload.name })
          : d,
      ),
      engineSaveRequest: null,
    }));
  },

  async saveDocumentAs(id) {
    const document = get().documents.find((d) => d.id === id);
    if (!document) return;

    // Hosted documents have no bytes here. The PDF save-as path would write an
    // empty file under a .pdf name; the engine has to do it instead — same as
    // the file menu's Save As.
    if (document.editor) {
      const target = await bridge().pickEditorSaveAsTarget(document.editor.sessionId, document.name);
      if (target) await get().requestEngineSave(id);
      return;
    }

    const result = await bridge().saveOutputAs({
      name: docs.saveAsName(document),
      bytes: document.bytes,
      mime: 'application/pdf',
    });
    if (!result) return;

    // The chosen destination becomes where ⌘S writes from now on.
    const written = result.written[0] ?? '';
    set((state) => ({
      documents: mapDocument(state.documents, id, (d) => docs.markSaved(d, written)),
    }));
  },

  async applyToolToDocument(id, tool, params, extraFiles = []) {
    const document = get().documents.find((d) => d.id === id);
    if (!document) throw new Error('That document is no longer open');

    // Deliberately not through `runTool`: applying a tool to what you are
    // looking at is an edit, and it belongs in the document's history rather
    // than as a row in the job list beside batch runs.
    const lead = { name: document.name, bytes: document.bytes, mime: 'application/pdf' as const };
    const extras = extraFiles.map((file) => ({
      name: file.name,
      bytes: file.bytes,
      mime: file.mime,
    }));
    const result = await bridge().runJob({
      jobId: crypto.randomUUID(),
      toolId: tool.id,
      files: [lead, ...extras],
      params: { ...params, password: document.password },
    });

    const outcome = classifyOutput(result.files);
    if (outcome.kind === 'document') {
      set((state) => ({
        documents: mapDocument(state.documents, id, (d) => docs.applyEdit(d, outcome.bytes)),
      }));
    }

    set((state) => {
      const recentToolIds = [tool.id, ...state.recentToolIds.filter((t) => t !== tool.id)].slice(
        0,
        RECENT_LIMIT,
      );
      if (hasBridge()) void bridge().updateSettings({ recentToolIds });
      return { recentToolIds };
    });

    return result;
  },

  async initialize() {
    if (!hasBridge()) {
      const dark = prefersDark();
      applyTheme(dark);
      set({ ready: true, darkMode: dark });
      return;
    }

    let settings: AppSettings;
    let catalog: Awaited<ReturnType<MagiesPdfBridge['getCatalog']>>;
    try {
      [settings, catalog] = await Promise.all([bridge().getSettings(), bridge().getCatalog()]);
    } catch (cause) {
      // Without this the promise just rejects, `ready` stays false and the app
      // spins on its loading indicator forever with nothing to act on.
      const dark = prefersDark();
      applyTheme(dark);
      set({
        ready: true,
        darkMode: dark,
        startupError: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }

    loadCatalog(catalog);

    const dark = resolveDark(settings.theme);
    applyTheme(dark);

    // Warm the Office editor host and pull its static assets into Chromium's
    // cache while the user is still on the home screen. First open still has
    // to convert the document; it should not also wait on sdkjs + fonts.
    // A same-origin hidden iframe is required — the editor runs on loopback
    // with its own port, so a fetch from the Vite origin would not share cache.
    void bridge()
      .warmEditor()
      .then(({ url }) => {
        if (!url || typeof document === 'undefined') return;
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.src = url;
        frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
        document.body.appendChild(frame);
        // Drop the frame once the heavy assets have had time to land.
        window.setTimeout(() => frame.remove(), 120_000);
      })
      .catch(() => undefined);

    // Track the OS theme while "system" is selected.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (get().settings.theme !== 'system') return;
      const next = prefersDark();
      applyTheme(next);
      set({ darkMode: next });
    });

    bridge().onJobProgress(({ jobId, fraction, message }) => {
      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === jobId ? { ...job, status: 'running', fraction, message } : job,
        ),
      }));
    });

    set({
      ready: true,
      settings,
      locale: settings.locale,
      darkMode: dark,
      recentToolIds: settings.recentToolIds,
    });
  },

  async setLocale(locale) {
    await get().updateSettings({ locale });
  },

  async setTheme(theme) {
    await get().updateSettings({ theme });
  },

  async updateSettings(patch) {
    const settings = hasBridge()
      ? await bridge().updateSettings(patch)
      : { ...get().settings, ...patch };

    const dark = resolveDark(settings.theme);
    applyTheme(dark);
    set({ settings, locale: settings.locale, darkMode: dark });
  },

  async runTool(tool, files, params) {
    const jobId = crypto.randomUUID();

    set((state) => {
      const recentToolIds = [tool.id, ...state.recentToolIds.filter((id) => id !== tool.id)].slice(
        0,
        RECENT_LIMIT,
      );
      if (hasBridge()) void bridge().updateSettings({ recentToolIds });

      return {
        recentToolIds,
        jobs: [
          {
            id: jobId,
            toolId: tool.id,
            toolName: tool.name,
            fileNames: files.map((f) => f.name),
            status: 'queued' as JobStatus,
            fraction: 0,
            startedAt: Date.now(),
          },
          ...state.jobs,
        ],
      };
    });

    // Return jobId immediately so the UI can show Cancel while the job runs.
    // Completion is applied asynchronously via progress events + this worker.
    void (async () => {
      try {
        const result = await bridge().runJob({
          jobId,
          toolId: tool.id,
          files: files.map((f) => ({ name: f.name, bytes: f.bytes, mime: f.mime })),
          params,
        });

        set((state) => ({
          jobs: state.jobs.map((job) =>
            job.id === jobId && job.status !== 'cancelled'
              ? { ...job, status: 'done', fraction: 1, result, finishedAt: Date.now() }
              : job,
          ),
        }));
      } catch (cause) {
        const error: SerializedToolError = isToolError(cause)
          ? cause
          : {
              __toolError: true,
              code: 'INTERNAL',
              message: cause instanceof Error ? cause.message : String(cause),
              userMessage: {
                zh: '处理失败，请重试。',
                en: 'Processing failed. Please try again.',
              },
            };

        set((state) => ({
          jobs: state.jobs.map((job) =>
            job.id === jobId && job.status !== 'cancelled'
              ? {
                  ...job,
                  status: error.code === 'CANCELLED' ? 'cancelled' : 'error',
                  error,
                  finishedAt: Date.now(),
                }
              : job,
          ),
        }));
      }
    })();

    return jobId;
  },

  async cancelJob(jobId) {
    if (hasBridge()) {
      await bridge().cancelJob(jobId);
    }
    // Optimistic UI: mark cancelled even if the worker is mid-chunk.
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === jobId && (job.status === 'queued' || job.status === 'running')
          ? {
              ...job,
              status: 'cancelled' as JobStatus,
              finishedAt: Date.now(),
              error: {
                __toolError: true as const,
                code: 'CANCELLED',
                message: 'cancelled',
                userMessage: { zh: '已取消', en: 'Cancelled' },
              },
            }
          : job,
      ),
    }));
  },

  clearFinishedJobs() {
    set((state) => ({
      jobs: state.jobs.filter((job) => job.status === 'queued' || job.status === 'running'),
    }));
  },

  markJobSaved(jobId, directory) {
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === jobId ? { ...job, savedTo: directory } : job)),
    }));
  },
}));

export function activeJobCount(jobs: readonly JobEntry[]): number {
  return jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
}
