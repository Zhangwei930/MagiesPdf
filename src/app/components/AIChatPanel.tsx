import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolOutputFile } from '@core/types.ts';
import type { DocumentState } from '../documents.ts';
import {
  bridge,
  hasBridge,
  type AiConfig,
  type AiAutomationState,
  type AiHistoryEntry,
  type AiHistoryInput,
  type AiWorkspaceStatus,
  type PickedFile,
} from '../bridge.ts';
import { formatBytes, localized, t, type Locale } from '../i18n.ts';
import {
  AlertCircle,
  BookOpen,
  Bot,
  FileText,
  FolderOpen,
  Loader2,
  Save,
  Send,
  Square,
  Trash2,
  Workflow,
  X,
} from '../icons.ts';
import {
  applyAiEvent,
  createHistoryInput,
  createTurnState,
  type AiChatMessage,
  type AiTurnState,
  type AiToolActivity,
  type AiWorkflowStep,
} from '../ai/chatState.ts';
import { Button, ProgressBar } from './ui.tsx';

interface AIChatPanelProps {
  open: boolean;
  locale: Locale;
  activeDocument: DocumentState | null;
  onClose(): void;
  onOpenSettings(): void;
  onPreviewFile(file: PickedFile): void;
}

function toolLabel(tool: AiToolActivity, locale: Locale): string {
  return localized(tool.toolName, locale) || tool.toolId;
}

function ArtifactActions({
  files,
  locale,
  onPreviewFile,
}: {
  files: ToolOutputFile[];
  locale: Locale;
  onPreviewFile(file: PickedFile): void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {files.map((file, index) => (
        <div
          key={`${file.name}-${index}`}
          className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2"
        >
          <FileText size={15} className="shrink-0 text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium">{file.name}</p>
            <p className="text-[10px] text-[var(--text-muted)]">{formatBytes(file.bytes.length, locale)}</p>
          </div>
          {file.mime === 'application/pdf' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => onPreviewFile({
                name: file.name,
                path: '',
                size: file.bytes.length,
                mime: file.mime,
                bytes: file.bytes,
              })}
            >
              {t('aiOpenFile', locale)}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            aria-label={t('aiSaveFile', locale)}
            onClick={() => void bridge().saveOutputAs(file)}
          >
            <Save size={13} />
          </Button>
        </div>
      ))}
      {files.length > 1 && (
        <Button
          size="sm"
          className="w-full"
          onClick={() => void bridge().saveOutputs(files)}
        >
          {t('saveAll', locale)}
        </Button>
      )}
    </div>
  );
}

function WorkflowPreview({ steps, locale }: { steps: AiWorkflowStep[]; locale: Locale }) {
  if (steps.length === 0) return null;
  return (
    <div className="mb-2 rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-2">
      <p className="text-[11px] font-medium">
        {locale === 'zh' ? '执行计划' : 'Execution plan'}
      </p>
      <ol className="mt-1 list-inside list-decimal space-y-0.5 text-[10px] text-[var(--text-secondary)]">
        {steps.map((step) => (
          <li key={step.callId}>{localized(step.toolName, locale) || step.toolId}</li>
        ))}
      </ol>
    </div>
  );
}

function ToolActivities({ tools, locale }: { tools: AiToolActivity[]; locale: Locale }) {
  if (tools.length === 0) return null;
  return (
    <div className="mb-2 space-y-1.5">
      {tools.map((tool) => (
        <div
          key={tool.callId}
          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-2"
        >
          <div className="flex items-center gap-2 text-[11px]">
            {tool.status === 'running' ? (
              <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
            ) : tool.status === 'error' ? (
              <AlertCircle size={12} className="text-[var(--danger)]" />
            ) : (
              <span className="text-[var(--success)]">✓</span>
            )}
            <span className="truncate font-medium">{toolLabel(tool, locale)}</span>
          </div>
          {tool.status === 'running' && <div className="mt-1.5"><ProgressBar value={tool.fraction} /></div>}
          {tool.details && (
            <details className="mt-1.5 text-[10px] text-[var(--text-secondary)]">
              <summary className="cursor-pointer">
                {locale === 'zh' ? '参数记录' : 'Argument record'}
              </summary>
              <pre className="mt-1 max-h-32 overflow-auto font-mono leading-relaxed whitespace-pre-wrap break-all">
                {tool.details}
              </pre>
            </details>
          )}
          {tool.error && <p className="mt-1 text-[10px] text-[var(--danger)]">{tool.error}</p>}
        </div>
      ))}
    </div>
  );
}

function TaskHistory({
  entries,
  locale,
  onReuse,
  onClear,
}: {
  entries: AiHistoryEntry[];
  locale: Locale;
  onReuse(entry: AiHistoryEntry): void;
  onClear(): void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-[12px] font-semibold">
            {locale === 'zh' ? '任务历史' : 'Task history'}
          </p>
          <p className="text-[10px] text-[var(--text-muted)]">
            {locale === 'zh' ? '仅保存在本机，最多 50 条' : 'Local only, up to 50 tasks'}
          </p>
        </div>
        {entries.length > 0 && (
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClear}>
            <Trash2 size={12} />
            {locale === 'zh' ? '清空' : 'Clear'}
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="py-8 text-center text-[11px] text-[var(--text-muted)]">
          {locale === 'zh' ? '还没有任务记录' : 'No task history yet'}
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2.5"
            >
              <div className="flex items-start gap-2">
                <span className={entry.success ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                  {entry.success ? '✓' : '×'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-[11px] font-medium">{entry.prompt}</p>
                  <p className="mt-1 text-[9px] text-[var(--text-muted)]">
                    {new Date(entry.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}
                  </p>
                  {entry.workflow.length > 0 && (
                    <p className="mt-1 truncate text-[9px] text-[var(--text-secondary)]">
                      {entry.workflow
                        .map((step) => localized(step.toolName, locale) || step.toolId)
                        .join(' → ')}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-[10px]"
                  onClick={() => onReuse(entry)}
                >
                  {locale === 'zh' ? '作为草稿' : 'Use draft'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface AutomationDraft {
  name: string;
  prompt: string;
  mode: 'review' | 'unattended';
  triggerType: 'daily' | 'folder';
  at: string;
  extensions: string;
  allowedToolIds: string[];
  maxRunsPerDay: number;
  retryLimit: number;
}

const EMPTY_AUTOMATION: AutomationDraft = {
  name: '',
  prompt: '',
  mode: 'review',
  triggerType: 'daily',
  at: '09:00',
  extensions: '.pdf, .docx, .xlsx, .pptx',
  allowedToolIds: [],
  maxRunsPerDay: 5,
  retryLimit: 1,
};

function AutomationManager({
  state,
  locale,
  workspace,
  onState,
  onUsePending,
  onError,
}: {
  state: AiAutomationState | null;
  locale: Locale;
  workspace: AiWorkspaceStatus | null;
  onState(state: AiAutomationState): void;
  onUsePending(prompt: string): void;
  onError(message: string): void;
}) {
  const [form, setForm] = useState<AutomationDraft>(EMPTY_AUTOMATION);
  const [creating, setCreating] = useState(false);

  const mutate = async (operation: () => Promise<AiAutomationState>) => {
    onError('');
    try {
      onState(await operation());
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createRule = async () => {
    setCreating(true);
    await mutate(async () => {
      const next = await bridge().createAiAutomationRule({
        name: form.name,
        prompt: form.prompt,
        mode: form.mode,
        trigger: form.triggerType === 'daily'
          ? { type: 'daily', at: form.at }
          : {
              type: 'folder',
              extensions: form.extensions.split(/[\s,，]+/).filter(Boolean),
            },
        allowedToolIds: form.mode === 'unattended' ? form.allowedToolIds : [],
        maxRunsPerDay: form.maxRunsPerDay,
        retryLimit: form.retryLimit,
      });
      setForm(EMPTY_AUTOMATION);
      return next;
    });
    setCreating(false);
  };

  const valid = form.name.trim() && form.prompt.trim()
    && (form.mode === 'review' || form.allowedToolIds.length > 0);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[12px] font-semibold">
          {locale === 'zh' ? '自动化任务' : 'Automations'}
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
          {locale === 'zh'
            ? '审核模式只生成待办；无人值守仅能调用你勾选的本地 Office 工具。'
            : 'Review mode creates a queue item. Unattended mode can call only selected local Office tools.'}
        </p>
      </div>

      {(state?.pending.length ?? 0) > 0 && (
        <section className="space-y-2">
          <p className="text-[11px] font-semibold">
            {locale === 'zh' ? `待审核（${state?.pending.length}）` : `Review queue (${state?.pending.length})`}
          </p>
          {state?.pending.map((pending) => (
            <div key={pending.id} className="rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] p-2.5">
              <p className="line-clamp-3 text-[11px] leading-relaxed">{pending.prompt}</p>
              <div className="mt-2 flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => void mutate(() => bridge().resolveAiAutomationPending(pending.id))}
                >
                  {locale === 'zh' ? '忽略' : 'Dismiss'}
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => {
                    onUsePending(pending.prompt);
                    void mutate(() => bridge().resolveAiAutomationPending(pending.id));
                  }}
                >
                  {locale === 'zh' ? '审核并编辑' : 'Review draft'}
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2.5">
        <p className="text-[11px] font-semibold">{locale === 'zh' ? '新建规则' : 'New rule'}</p>
        <input
          value={form.name}
          placeholder={locale === 'zh' ? '规则名称' : 'Rule name'}
          className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px] outline-none focus:border-[var(--accent)]"
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
        />
        <textarea
          value={form.prompt}
          rows={3}
          placeholder={locale === 'zh' ? '任务说明，例如：读取新表格并生成汇总图表' : 'Task instructions'}
          className="w-full resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px] outline-none focus:border-[var(--accent)]"
          onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            value={form.mode}
            className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px]"
            onChange={(event) => setForm((current) => ({
              ...current,
              mode: event.target.value as AutomationDraft['mode'],
            }))}
          >
            <option value="review">{locale === 'zh' ? '审核队列（推荐）' : 'Review queue (recommended)'}</option>
            <option value="unattended">{locale === 'zh' ? '无人值守' : 'Unattended'}</option>
          </select>
          <select
            value={form.triggerType}
            className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px]"
            onChange={(event) => setForm((current) => ({
              ...current,
              triggerType: event.target.value as AutomationDraft['triggerType'],
            }))}
          >
            <option value="daily">{locale === 'zh' ? '每天定时' : 'Daily'}</option>
            <option value="folder">{locale === 'zh' ? '新文件进入目录' : 'New workspace file'}</option>
          </select>
        </div>
        {form.triggerType === 'daily' ? (
          <input
            type="time"
            value={form.at}
            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px]"
            onChange={(event) => setForm((current) => ({ ...current, at: event.target.value }))}
          />
        ) : (
          <input
            value={form.extensions}
            placeholder=".pdf, .docx, .xlsx, .pptx"
            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px] outline-none focus:border-[var(--accent)]"
            onChange={(event) => setForm((current) => ({ ...current, extensions: event.target.value }))}
          />
        )}
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <label>
            <span className="text-[var(--text-muted)]">{locale === 'zh' ? '每日上限' : 'Daily cap'}</span>
            <input
              type="number"
              min={1}
              max={20}
              value={form.maxRunsPerDay}
              className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5"
              onChange={(event) => setForm((current) => ({
                ...current,
                maxRunsPerDay: Number(event.target.value),
              }))}
            />
          </label>
          <label>
            <span className="text-[var(--text-muted)]">{locale === 'zh' ? '失败重试' : 'Retries'}</span>
            <input
              type="number"
              min={0}
              max={2}
              value={form.retryLimit}
              className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5"
              onChange={(event) => setForm((current) => ({
                ...current,
                retryLimit: Number(event.target.value),
              }))}
            />
          </label>
        </div>
        {form.mode === 'unattended' && (
          <div>
            <p className="mb-1 text-[10px] font-medium">
              {locale === 'zh' ? '允许自动调用的工具' : 'Allowed automatic tools'}
            </p>
            {!workspace?.configured ? (
              <p className="text-[10px] text-[var(--danger)]">
                {locale === 'zh' ? '请先授权上方办公目录。' : 'Grant an Office workspace first.'}
              </p>
            ) : (
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-md bg-[var(--surface-sunken)] p-2">
                {state?.tools.map((tool) => (
                  <label key={tool.toolId} className="flex items-start gap-2 text-[10px]">
                    <input
                      type="checkbox"
                      checked={form.allowedToolIds.includes(tool.toolId)}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        allowedToolIds: event.target.checked
                          ? [...current.allowedToolIds, tool.toolId]
                          : current.allowedToolIds.filter((toolId) => toolId !== tool.toolId),
                      }))}
                    />
                    <span>{localized(tool.toolName, locale) || tool.toolId}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <Button
          size="sm"
          className="w-full"
          disabled={!valid || creating || !hasBridge()}
          onClick={() => void createRule()}
        >
          {creating ? <Loader2 size={12} className="animate-spin" /> : <Workflow size={12} />}
          {locale === 'zh' ? '创建自动化规则' : 'Create automation'}
        </Button>
      </section>

      <section className="space-y-2">
        <p className="text-[11px] font-semibold">
          {locale === 'zh' ? `规则（${state?.rules.length ?? 0}）` : `Rules (${state?.rules.length ?? 0})`}
        </p>
        {state?.rules.map((rule) => (
          <div key={rule.id} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-2.5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium">{rule.name}</p>
                <p className="mt-1 text-[9px] text-[var(--text-muted)]">
                  {rule.mode === 'review'
                    ? (locale === 'zh' ? '审核队列' : 'Review')
                    : (locale === 'zh' ? '无人值守' : 'Unattended')}
                  {' · '}
                  {rule.trigger.type === 'daily'
                    ? `${locale === 'zh' ? '每天' : 'Daily'} ${rule.trigger.at}`
                    : rule.trigger.extensions.join(', ')}
                  {` · ${rule.runCount}/${rule.maxRunsPerDay}`}
                </p>
                {rule.lastError && <p className="mt-1 line-clamp-2 text-[9px] text-[var(--danger)]">{rule.lastError}</p>}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[10px]"
                onClick={() => void mutate(() => bridge().setAiAutomationRuleEnabled(rule.id, !rule.enabled))}
              >
                {rule.enabled
                  ? (locale === 'zh' ? '暂停' : 'Pause')
                  : (locale === 'zh' ? '启用' : 'Enable')}
              </Button>
              <button
                type="button"
                className="rounded-md p-1.5 text-[var(--text-muted)] hover:text-[var(--danger)]"
                aria-label={locale === 'zh' ? '删除规则' : 'Delete rule'}
                onClick={() => {
                  if (window.confirm(locale === 'zh' ? '确定删除这条自动化规则吗？' : 'Delete this automation rule?')) {
                    void mutate(() => bridge().deleteAiAutomationRule(rule.id));
                  }
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </section>

      {(state?.runs.length ?? 0) > 0 && (
        <section className="space-y-1.5">
          <p className="text-[11px] font-semibold">{locale === 'zh' ? '最近运行' : 'Recent runs'}</p>
          {state?.runs.slice(0, 10).map((run) => (
            <div key={run.id} className="flex gap-2 rounded-md bg-[var(--surface-sunken)] px-2 py-1.5 text-[10px]">
              <span className={run.status === 'error' ? 'text-[var(--danger)]' : 'text-[var(--success)]'}>
                {run.status === 'queued' ? '…' : run.status === 'success' ? '✓' : '×'}
              </span>
              <span className="min-w-0 flex-1 truncate">{run.message}</span>
              <span className="text-[var(--text-muted)]">
                {new Date(run.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function AIChatPanel({
  open,
  locale,
  activeDocument,
  onClose,
  onOpenSettings,
  onPreviewFile,
}: AIChatPanelProps) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [turn, setTurn] = useState<AiTurnState | null>(null);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [workspace, setWorkspace] = useState<AiWorkspaceStatus | null>(null);
  const [taskHistory, setTaskHistory] = useState<AiHistoryEntry[]>([]);
  const [automationState, setAutomationState] = useState<AiAutomationState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [error, setError] = useState('');
  const turnRef = useRef<AiTurnState | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const updateTurn = useCallback((change: (current: AiTurnState) => AiTurnState) => {
    setTurn((current) => {
      if (!current) return current;
      const next = change(current);
      turnRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!hasBridge()) return;
    return bridge().onAiEvent((event) => {
      updateTurn((current) => applyAiEvent(current, event));
    });
  }, [updateTurn]);

  useEffect(() => {
    if (!hasBridge()) return;
    return bridge().onAiAutomationEvent(() => {
      void bridge().getAiAutomationState().then(setAutomationState).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    });
  }, []);

  useEffect(() => {
    if (!open || !hasBridge()) return;
    void bridge().getAiConfig().then(setConfig).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    void bridge().getAiWorkspaceStatus().then(setWorkspace).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    void bridge().getAiHistory().then(setTaskHistory).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    void bridge().getAiAutomationState().then(setAutomationState).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [open]);

  const persistHistory = useCallback(async (input: AiHistoryInput) => {
    try {
      const entry = await bridge().appendAiHistory(input);
      setTaskHistory((current) => [
        entry,
        ...current.filter((item) => item.id !== entry.id),
      ].slice(0, 50));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const clearHistory = useCallback(async () => {
    if (!hasBridge()) return;
    const confirmed = window.confirm(
      locale === 'zh' ? '确定清空本机任务历史吗？' : 'Clear local task history?',
    );
    if (!confirmed) return;
    try {
      await bridge().clearAiHistory();
      setTaskHistory([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [locale]);

  const chooseWorkspace = useCallback(async () => {
    if (!hasBridge() || turn) return;
    setError('');
    try {
      setWorkspace(await bridge().pickAiWorkspace());
      setAutomationState(await bridge().getAiAutomationState());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [turn]);

  const clearWorkspace = useCallback(async () => {
    if (!hasBridge() || turn) return;
    setError('');
    try {
      setWorkspace(await bridge().clearAiWorkspace());
      setAutomationState(await bridge().getAiAutomationState());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [turn]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, turn?.assistantText, turn?.tools.length, turn?.approvals.length]);

  const send = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || turn || !hasBridge()) return;

    setError('');
    try {
      const currentConfig = await bridge().getAiConfig();
      setConfig(currentConfig);
      if (!currentConfig.model.trim()) {
        setError(t('aiNoModel', locale));
        return;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    const requestId = crypto.randomUUID();
    const currentTurn = createTurnState(requestId);
    turnRef.current = currentTurn;
    setTurn(currentTurn);
    setDraft('');
    setHistoryOpen(false);
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: prompt },
    ]);

    try {
      const result = await bridge().runAiTurn({
        requestId,
        prompt,
        history,
        locale,
        files: activeDocument
          ? [{
              id: 'file-1',
              name: activeDocument.name,
              mime: 'application/pdf',
              bytes: activeDocument.bytes,
              password: activeDocument.password,
            }]
          : [],
      });
      const completed = turnRef.current;
      const response = result.message || completed?.assistantText || '';
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response,
          workflow: completed?.workflow,
          tools: completed?.tools,
          artifacts: result.files,
        },
      ]);
      await persistHistory(createHistoryInput({
        prompt,
        response,
        success: true,
        turn: completed,
        artifacts: result.files,
      }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'assistant', content: message, error: true },
      ]);
      await persistHistory(createHistoryInput({
        prompt,
        response: message,
        success: false,
        turn: turnRef.current,
        artifacts: [],
      }));
    } finally {
      turnRef.current = null;
      setTurn(null);
    }
  }, [activeDocument, draft, locale, messages, persistHistory, turn]);

  return (
    <aside
      className={`${open ? 'flex' : 'hidden'} h-full w-[390px] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-panel)]`}
      aria-label={t('aiAssistant', locale)}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        <Bot size={16} className="text-[var(--accent)]" />
        <h2 className="flex-1 text-[13px] font-semibold">{t('aiAssistant', locale)}</h2>
        <button
          type="button"
          disabled={Boolean(turn)}
          onClick={() => {
            setAutomationOpen((current) => !current);
            setHistoryOpen(false);
          }}
          className={`rounded-md p-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-50 ${automationOpen ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
          aria-label={locale === 'zh' ? '自动化任务' : 'Automations'}
          aria-pressed={automationOpen}
        >
          <Workflow size={15} />
        </button>
        <button
          type="button"
          disabled={Boolean(turn)}
          onClick={() => {
            setHistoryOpen((current) => !current);
            setAutomationOpen(false);
          }}
          className={`rounded-md p-1.5 hover:bg-[var(--surface-hover)] disabled:opacity-50 ${historyOpen ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
          aria-label={locale === 'zh' ? '任务历史' : 'Task history'}
          aria-pressed={historyOpen}
        >
          <BookOpen size={15} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
          aria-label={t('close', locale)}
        >
          <X size={15} />
        </button>
      </div>

      {activeDocument && (
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-[var(--accent)]">
          <FileText size={13} />
          <span className="truncate">{activeDocument.name}</span>
        </div>
      )}

      <div className="border-b border-[var(--border-subtle)] px-3 py-2">
        {workspace?.configured ? (
          <div className="flex items-center gap-2">
            <FolderOpen size={13} className="shrink-0 text-[var(--success)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-[var(--text-muted)]">{t('aiWorkspaceLabel', locale)}</p>
              <p className="truncate text-[11px] font-medium" title={workspace.path}>{workspace.path}</p>
            </div>
            <button
              type="button"
              disabled={Boolean(turn)}
              onClick={() => void clearWorkspace()}
              className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
              aria-label={t('aiWorkspaceClear', locale)}
              title={t('aiWorkspaceClear', locale)}
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              disabled={Boolean(turn)}
              onClick={() => void chooseWorkspace()}
            >
              <FolderOpen size={13} />
              {t('aiWorkspaceChoose', locale)}
            </Button>
            <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
              {t('aiWorkspaceHint', locale)}
            </p>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {automationOpen && (
          <AutomationManager
            state={automationState}
            locale={locale}
            workspace={workspace}
            onState={setAutomationState}
            onError={setError}
            onUsePending={(prompt) => {
              setDraft(prompt);
              setAutomationOpen(false);
            }}
          />
        )}
        {historyOpen && (
          <TaskHistory
            entries={taskHistory}
            locale={locale}
            onClear={() => void clearHistory()}
            onReuse={(entry) => {
              setDraft(entry.prompt);
              setHistoryOpen(false);
            }}
          />
        )}
        {!historyOpen && !automationOpen && messages.length === 0 && !turn && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center">
            <Bot size={28} strokeWidth={1.5} className="mb-3 text-[var(--accent)]" />
            <p className="text-sm font-medium">{t('aiEmpty', locale)}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-muted)]">
              {t('aiEmptyHint', locale)}
            </p>
            {!config?.model && (
              <Button size="sm" className="mt-4" onClick={onOpenSettings}>
                {t('aiOpenSettings', locale)}
              </Button>
            )}
          </div>
        )}

        <div className="space-y-3">
          {!historyOpen && !automationOpen && messages.map((message) => (
            <div
              key={message.id}
              className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={message.role === 'user'
                  ? 'max-w-[88%] rounded-xl rounded-br-sm bg-[var(--accent)] px-3 py-2 text-[13px] whitespace-pre-wrap text-white'
                  : `max-w-full rounded-xl rounded-bl-sm border px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap ${message.error ? 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]' : 'border-[var(--border-subtle)] bg-[var(--surface-raised)]'}`}
              >
                {message.workflow && <WorkflowPreview steps={message.workflow} locale={locale} />}
                {message.tools && <ToolActivities tools={message.tools} locale={locale} />}
                {message.content}
                {message.artifacts && (
                  <ArtifactActions files={message.artifacts} locale={locale} onPreviewFile={onPreviewFile} />
                )}
              </div>
            </div>
          ))}

          {!historyOpen && !automationOpen && turn && (
            <div className="rounded-xl rounded-bl-sm border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[13px]">
              <WorkflowPreview steps={turn.workflow} locale={locale} />
              <ToolActivities tools={turn.tools} locale={locale} />
              {turn.assistantText ? (
                <p className="leading-relaxed whitespace-pre-wrap">{turn.assistantText}</p>
              ) : turn.approvals.length === 0 ? (
                <div className="flex items-center gap-2 text-[var(--text-muted)]">
                  <Loader2 size={13} className="animate-spin" />
                  {t('aiThinking', locale)}
                </div>
              ) : null}
              {turn.approvals.map((approval) => (
                <div key={approval.approvalId} className="mt-2 rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] p-2.5">
                  <p className="text-[12px] font-medium">{t('aiApprovalTitle', locale)}</p>
                          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                            {localized(approval.toolName, locale) || approval.toolId}
                            {approval.inputFileNames.length > 0 ? ` · ${approval.inputFileNames.join(', ')}` : ''}
                          </p>
                          {approval.details && (
                            <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all">
                              {approval.details}
                            </pre>
                          )}
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void bridge().respondAiApproval(turn.requestId, approval.approvalId, false)}
                    >
                      {t('aiDeny', locale)}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void bridge().respondAiApproval(turn.requestId, approval.approvalId, true)}
                    >
                      {t('aiApprove', locale)}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {error && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg bg-[var(--danger-soft)] px-2.5 py-2 text-[11px] text-[var(--danger)]">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={onOpenSettings} className="font-medium underline">
            {t('aiOpenSettings', locale)}
          </button>
        </div>
      )}

      {!automationOpen && <div className="shrink-0 border-t border-[var(--border-subtle)] p-3">
        <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-2 focus-within:border-[var(--accent)]">
          <textarea
            value={draft}
            rows={3}
            disabled={Boolean(turn)}
            placeholder={t('aiPlaceholder', locale)}
            className="w-full resize-none bg-transparent px-1 text-[13px] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-60"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="max-w-[240px] truncate text-[10px] text-[var(--text-muted)]">
              {config?.model || t('aiNoModelShort', locale)}
            </span>
            {turn ? (
              <Button
                size="sm"
                variant="danger"
                className="h-7 px-2"
                onClick={() => void bridge().cancelAiTurn(turn.requestId)}
              >
                <Square size={11} fill="currentColor" />
                {t('aiStop', locale)}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                className="h-7 px-2"
                disabled={!draft.trim() || !hasBridge()}
                onClick={() => void send()}
              >
                <Send size={12} />
                {t('aiSend', locale)}
              </Button>
            )}
          </div>
        </div>
      </div>}
    </aside>
  );
}
