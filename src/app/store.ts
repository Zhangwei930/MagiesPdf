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
import type { Locale } from './i18n.ts';

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
  autoUpdate: true,
  api: { enabled: false, port: 8737, token: '', allowLan: false },
  externalConverter: { executable: '', argumentTemplate: '', timeoutMs: 120000 },
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

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  startupError: '',
  settings: DEFAULT_SETTINGS,
  locale: DEFAULT_SETTINGS.locale,
  darkMode: false,
  jobs: [],
  recentToolIds: [],

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

    try {
      const result = await bridge().runJob({
        jobId,
        toolId: tool.id,
        files: files.map((f) => ({ name: f.name, bytes: f.bytes, mime: f.mime })),
        params,
      });

      set((state) => ({
        jobs: state.jobs.map((job) =>
          job.id === jobId
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
          job.id === jobId
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

    return jobId;
  },

  async cancelJob(jobId) {
    if (hasBridge()) await bridge().cancelJob(jobId);
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
