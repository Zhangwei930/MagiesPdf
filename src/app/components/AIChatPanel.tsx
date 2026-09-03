import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolOutputFile } from '@core/types.ts';
import type { DocumentState } from '../documents.ts';
import { OfficeApprovalCard, OfficeApprovalTrail } from './OfficeApprovalCard.tsx';
import type { ApprovalDecision, OfficeApprovalRecord } from '../ai/officeApprovals.ts';
import { officeCreateKind } from '../documents.ts';
import {
  bridge,
  hasBridge,
  type AiActiveOffice,
  type AiConfig,
  type AiAutomationState,
  type AiHistoryEntry,
  type AiHistoryInput,
  type AiOfficeContext,
  type AiWorkspaceStatus,
  type CliAgentStatus,
  type OfficeToolApproval,
  type PickedFile,
} from '../bridge.ts';
import { formatBytes, localized, t, type Locale } from '../i18n.ts';
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  Eye,
  FileText,
  FolderOpen,
  Loader2,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Zap,
  Workflow,
  X,
} from '../icons.ts';
import { renderAssistantMarkdown } from '../ai/markdown.ts';
import {
  applyAiEvent,
  createHistoryInput,
  createTurnState,
  type AiChatMessage,
  type AiTurnState,
  type AiToolActivity,
  type AiWorkflowStep,
} from '../ai/chatState.ts';
import { Button } from './ui.tsx';
import { useApp } from '../store.ts';
import { trimHistory } from '../ai/history.ts';
import {
  emptySessionMemory,
  historyWithToolMemory,
  rememberToolResult,
  type SessionMemory,
} from '../ai/sessionMemory.ts';
import { ActivityIndicator, IconPlate } from './settingsUi.tsx';
import { VendorMark } from './AiProviderList.tsx';
import { ToolCallCard } from './AiToolCall.tsx';

/**
 * Assistant replies are markdown. The rhythm here — paragraph spacing, code
 * plates, table hairlines — is what makes a long answer readable in a 400px
 * column; it is one constant because both the finished message and the
 * streaming one must look identical as the text lands.
 */
/**
 * Openers for a blank panel. They are the tasks this assistant is actually
 * good at, so the first turn is a working one rather than "what can you do?".
 */
const SUGGESTIONS: Record<Locale, string[]> = {
  zh: [
    '给当前 Excel 随机填销售数据，做好表头样式和汇总统计',
    '把当前 PDF 转换成 Word 文档',
    '提取这份 PDF 的目录和每章摘要',
  ],
  en: [
    'Fill the current spreadsheet with sample sales data, nice headers, and totals',
    'Convert the current PDF to a Word document',
    'Extract the outline and a summary of each chapter',
  ],
};

/**
 * The permission modes as the panel names them.
 *
 * Worded so someone who has never opened Settings can tell what will happen:
 * each label says what the assistant does about *your files*, not what the
 * policy is called.
 */
const PERMISSION_BADGES = {
  observer: {
    icon: Eye,
    label: { zh: '只读模式', en: 'Read-only' },
    hint: {
      zh: '只读模式：AI 只能查看和分析，不能修改文件、也不能联网。想改会被直接拒绝。',
      en: 'Read-only: the assistant can look and analyse but cannot change files or go online. Such attempts are refused.',
    },
    className: 'border-[var(--border-strong)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
  },
  confirm: {
    icon: ShieldCheck,
    label: { zh: '每次授权', en: 'Ask each time' },
    hint: {
      zh: '每次授权：AI 改文件或联网前会先弹卡片给你确认，你同意才执行。只是查看不打扰你。',
      en: 'Ask me: before changing a file or going online it shows a card and waits for you. Just reading does not interrupt.',
    },
    className: 'border-[var(--success)]/40 bg-[var(--success-soft)] text-[var(--success)]',
  },
  auto: {
    icon: Zap,
    label: { zh: '自动模式', en: 'Automatic' },
    hint: {
      zh: '自动模式：AI 改文件、联网都不再询问，直接执行。运行宏这类仍会问你。',
      en: 'Do not ask: it changes files and goes online without asking. Tools that execute arbitrary code still stop and ask.',
    },
    className: 'border-[var(--warning)]/50 bg-[var(--warning-soft)] text-[var(--warning)]',
  },
} as const;

const PROSE = [
  'max-w-none text-[13.5px] leading-[1.7]',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_p]:my-2 [&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:pl-5 [&_ol]:list-decimal',
  '[&_li]:my-0.5',
  '[&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2',
  '[&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:mt-3.5 [&_h2]:mb-1.5',
  '[&_h3]:text-[13.5px] [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1',
  '[&_code]:font-mono [&_code]:text-[12px]',
  '[&_p_code]:rounded [&_p_code]:bg-[var(--surface-sunken)] [&_p_code]:px-1 [&_p_code]:py-px',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)] [&_pre]:bg-[var(--surface-sunken)] [&_pre]:p-2.5',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-strong)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)]',
  '[&_a]:text-[var(--accent)] [&_a]:underline [&_a]:underline-offset-2',
  '[&_hr]:my-4 [&_hr]:border-[var(--border-subtle)]',
  '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px]',
  '[&_th]:border [&_th]:border-[var(--border-subtle)] [&_th]:bg-[var(--surface-sunken)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
  '[&_td]:border [&_td]:border-[var(--border-subtle)] [&_td]:px-2 [&_td]:py-1',
].join(' ');

interface AIChatPanelProps {
  open: boolean;
  locale: Locale;
  /** Confirm-mode questions from outside this window, awaiting an answer. */
  officeApprovals: OfficeToolApproval[];
  officeApprovalRecords: OfficeApprovalRecord[];
  onAnswerOfficeApproval(approvalId: string, decision: ApprovalDecision): void;
  activeDocument: DocumentState | null;
  pendingPrompt?: string | null;
  onClose(): void;
  onOpenSettings(): void;
  onPreviewFile(file: PickedFile): void;
  /** Open AI-written Office paths as tabs (absolute paths). */
  onOpenPaths?(paths: string[]): void;
  onClearPendingPrompt?(): void;
}

const OFFICE_MIME: Record<string, string> = {
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
};

/** Join a workspace root and a relative path without importing node:path. */
function joinWorkspacePath(root: string, relative: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  const rel = relative.replace(/^[\\/]+/, '').replace(/\\/g, '/').split('/').join(sep);
  return `${base}${sep}${rel}`;
}

function relativeToWorkspace(workspacePath: string, documentPath: string): string {
  if (!workspacePath || !documentPath) return '';
  const normRoot = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normDoc = documentPath.replace(/\\/g, '/');
  if (normDoc === normRoot) return '';
  if (!normDoc.startsWith(`${normRoot}/`)) return '';
  return normDoc.slice(normRoot.length + 1);
}

function buildActiveOffice(
  document: DocumentState | null,
  workspacePath: string,
): AiActiveOffice | null {
  if (!document) return null;
  const kind = document.editor ? officeCreateKind(document) : 'pdf';
  const path = document.path || '';
  const relativePath = relativeToWorkspace(workspacePath, path);
  return {
    name: document.name,
    path,
    relativePath,
    kind,
    sessionId: document.editor?.sessionId,
    dirty: Boolean(document.editor ? document.engineModified : !document.saved),
    inWorkspace: relativePath !== '',
    saved: path !== '',
  };
}

function buildTurnFiles(document: DocumentState | null): Array<{
  id: string;
  name: string;
  path?: string;
  mime: string;
  bytes: Uint8Array;
  password?: string;
}> {
  if (!document) return [];
  // Office tabs hold no PDF bytes — only path/name for CLI preamble.
  if (document.editor) {
    const kind = officeCreateKind(document);
    return [{
      id: 'file-1',
      name: document.name,
      path: document.path || '',
      mime: OFFICE_MIME[kind] || 'application/octet-stream',
      bytes: new Uint8Array(0),
    }];
  }
  return [{
    id: 'file-1',
    name: document.name,
    path: document.path || '',
    mime: 'application/pdf',
    bytes: document.bytes,
    password: document.password,
  }];
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
    <div className="mb-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-secondary)]">
        <Sparkles size={12} className="text-[var(--accent)]" />
        {locale === 'zh' ? '执行计划' : 'Execution plan'}
      </div>
      <ol className="mt-1.5 space-y-1">
        {steps.map((step, index) => (
          <li key={step.callId} className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[9px] font-semibold text-[var(--accent)]">
              {index + 1}
            </span>
            <span className="truncate">{localized(step.toolName, locale) || step.toolId}</span>
          </li>
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
        <ToolCallCard key={tool.callId} tool={tool} locale={locale} />
      ))}
    </div>
  );
}

function TaskHistory({
  entries,
  locale,
  onReuse,
  onRemove,
  onClear,
}: {
  entries: AiHistoryEntry[];
  locale: Locale;
  onReuse(entry: AiHistoryEntry): void;
  onRemove(entryId: string): void;
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
              className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2.5 shadow-[var(--shadow-card)]"
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
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => onReuse(entry)}
                  >
                    {locale === 'zh' ? '作为草稿' : 'Use draft'}
                  </Button>
                  <button
                    type="button"
                    onClick={() => onRemove(entry.id)}
                    className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                    aria-label={locale === 'zh' ? '删除这条记录' : 'Delete this task'}
                    title={locale === 'zh' ? '删除这条记录' : 'Delete this task'}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
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
            <div key={pending.id} className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-2.5">
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

      <section className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-3 shadow-[var(--shadow-card)]">
        <p className="text-[11px] font-semibold">{locale === 'zh' ? '新建规则' : 'New rule'}</p>
        <input
          value={form.name}
          placeholder={locale === 'zh' ? '规则名称' : 'Rule name'}
          className="field-input text-[11px]"
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
        />
        <textarea
          value={form.prompt}
          rows={3}
          placeholder={locale === 'zh' ? '任务说明，例如：读取新表格并生成汇总图表' : 'Task instructions'}
          className="field-input resize-none text-[11px]"
          onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
        />
        <div className="grid grid-cols-2 gap-2">
          <select
            value={form.mode}
            className="field-input text-[11px]"
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
            className="field-input text-[11px]"
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
            className="field-input text-[11px]"
            onChange={(event) => setForm((current) => ({ ...current, at: event.target.value }))}
          />
        ) : (
          <input
            value={form.extensions}
            placeholder=".pdf, .docx, .xlsx, .pptx"
            className="field-input text-[11px]"
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
              className="field-input mt-1 text-[10px]"
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
              className="field-input mt-1 text-[10px]"
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
          <div key={rule.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2.5 shadow-[var(--shadow-card)]">
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
  officeApprovals,
  officeApprovalRecords,
  onAnswerOfficeApproval,
  activeDocument,
  pendingPrompt,
  onClose,
  onOpenSettings,
  onPreviewFile,
  onOpenPaths,
  onClearPendingPrompt,
}: AIChatPanelProps) {
  /**
   * Read from the store rather than the turn config: the badge has to show what
   * the *next* turn will do, and it changes in settings while the panel is open.
   */
  const permissionMode = useApp((state) => state.settings.ai.permissionMode) ?? 'confirm';
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [turn, setTurn] = useState<AiTurnState | null>(null);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [workspace, setWorkspace] = useState<AiWorkspaceStatus | null>(null);
  /** True while we are granting from the active tab's path. */
  const [workspaceSyncing, setWorkspaceSyncing] = useState(false);
  /**
   * How the current grant was established — drives the strip label so users
   * know it followed the left-hand tab rather than a manual pick.
   */
  const [workspaceSource, setWorkspaceSource] = useState<'document' | 'manual' | ''>('');
  const [taskHistory, setTaskHistory] = useState<AiHistoryEntry[]>([]);
  const [automationState, setAutomationState] = useState<AiAutomationState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [error, setError] = useState('');
  /** '' runs the configured model; `cli:<id>` hands the turn to that CLI. */
  const [agent, setAgent] = useState('');
  const [cliAgents, setCliAgents] = useState<CliAgentStatus[]>([]);
  /** Models the selected CLI reports right now, keyed by agent id. */
  const [cliModels, setCliModels] = useState<Record<string, Array<{ id: string; name: string }>>>({});
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  /**
   * Cross-turn working memory for Office paths and tool outcomes. Survives as
   * long as this panel stays mounted (closing the drawer keeps the mount).
   */
  const [sessionMemory, setSessionMemory] = useState<SessionMemory>(() => emptySessionMemory());
  const turnRef = useRef<AiTurnState | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && pendingPrompt && pendingPrompt.trim() !== '') {
      const timer = setTimeout(() => {
        setDraft(pendingPrompt);
        onClearPendingPrompt?.();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [open, pendingPrompt, onClearPendingPrompt]);

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

      if (event.type === 'tool_result') {
        // Keep multi-turn memory of what tools did — text history alone drops this.
        setSessionMemory((current) => rememberToolResult(current, {
          toolId: event.toolId,
          ok: event.ok,
          result: event.result,
          error: event.error,
        }));
      }

      // In-place mutators are reopened via office:documentApplied (same path).
      // Batch / multi-file tools still open written paths here.
      if (
        event.type === 'tool_result'
        && event.ok
        && event.toolId.startsWith('office:')
        && onOpenPaths
      ) {
        const payload = event.result as {
          written?: string | string[];
          appliedInPlace?: boolean;
        } | undefined;
        if (payload?.appliedInPlace) {
          // Main process closes the session and reopens the path — nothing to open here.
        } else {
          const written = payload?.written;
          const paths = Array.isArray(written) ? written : written ? [written] : [];
          const root = workspace?.path || '';
          if (root && paths.length > 0) {
            const absolute = paths
              .filter((item): item is string => typeof item === 'string' && item.length > 0)
              .map((item) => (item.startsWith('/') || /^[A-Za-z]:[\\/]/.test(item)
                ? item
                : joinWorkspacePath(root, item)));
            if (absolute.length > 0) void onOpenPaths(absolute);
          }
        }
      }
    });
  }, [onOpenPaths, updateTurn, workspace?.path]);

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
    void bridge().getAiWorkspaceStatus().then((status) => {
      setWorkspace(status);
      // Restored grant from a previous session has no tab provenance.
      if (status.configured) setWorkspaceSource((current) => current || 'manual');
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    void bridge().getAiHistory().then(setTaskHistory).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    void bridge().getAiAutomationState().then(setAutomationState).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    void bridge().getCliAgents()
      .then((found) => {
        const usable = found.filter((entry) => entry.installed && entry.runnable);
        setCliAgents(usable);
        // Warm every installed CLI's model list while the user is still
        // reading: asking on selection meant the shipped fallback showed
        // first and was swapped a second later, which looks like a glitch.
        for (const entry of usable) {
          void bridge()
            .getCliModels(entry.id)
            .then((models) => setCliModels((current) => (
              current[entry.id] ? current : { ...current, [entry.id]: models }
            )))
            .catch(() => {
              // The list detection already returned stays in use.
            });
        }
      })
      .catch(() => {
        // Detection is a convenience; the model runtime works without it.
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

  /** One task, deleted where it sits — no confirmation for a single row. */
  const removeHistoryEntry = useCallback(async (entryId: string) => {
    if (!hasBridge()) return;
    try {
      await bridge().removeAiHistoryEntry(entryId);
      setTaskHistory((current) => current.filter((entry) => entry.id !== entryId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const chooseWorkspace = useCallback(async () => {
    if (!hasBridge() || turn) return;
    setError('');
    try {
      setWorkspace(await bridge().pickAiWorkspace());
      setWorkspaceSource('manual');
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
      setWorkspaceSource('');
      setAutomationState(await bridge().getAiAutomationState());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [turn]);

  /**
   * Office workspace follows the left-hand active tab:
   * - saved document open → grant its parent folder (multi-tab uses the selected one)
   * - nothing open / unsaved → leave unset so the user can pick manually
   */
  useEffect(() => {
    if (!open || !hasBridge()) return;
    const docPath = activeDocument?.path?.trim() || '';
    if (!docPath) return;

    // Already authorized for a folder that contains this file — keep it
    // (covers a manual grant of a parent that holds several open docs).
    if (
      workspace?.configured
      && workspace.path
      && relativeToWorkspace(workspace.path, docPath)
    ) {
      return;
    }

    let cancelled = false;
    // The grant is the external system here; every piece of state it produces —
    // the spinner included — belongs to the request rather than to the
    // synchronous effect body.
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setWorkspaceSyncing(true);
      try {
        const status = await bridge().grantAiWorkspaceForPath(docPath);
        if (cancelled) return;
        setWorkspace(status);
        setWorkspaceSource('document');
        setError('');
      } catch (cause: unknown) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setWorkspaceSyncing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, activeDocument?.path, workspace?.configured, workspace?.path]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, turn?.assistantText, turn?.tools.length, turn?.approvals.length]);

  const selectedCliAgent = agent.startsWith('cli:')
    ? cliAgents.find((entry) => `cli:${entry.id}` === agent) ?? null
    : null;

  /** The model and effort stored for the CLI currently selected. */
  const cliAgentId = agent.startsWith('cli:') ? agent.slice(4) : '';
  const storedChoice = settings.ai.cliModels?.[cliAgentId] ?? {};
  const cliChoice = { model: storedChoice.model ?? '', effort: storedChoice.effort ?? '' };

  const modelChoices = cliModels[cliAgentId] ?? selectedCliAgent?.models ?? [];

  // The shipped list goes stale, so the chosen CLI is asked for its own once.
  useEffect(() => {
    if (!cliAgentId || !hasBridge() || cliModels[cliAgentId]) return;
    let cancelled = false;
    void bridge()
      .getCliModels(cliAgentId)
      .then((models) => {
        if (!cancelled) setCliModels((current) => ({ ...current, [cliAgentId]: models }));
      })
      .catch(() => {
        // The static list the detection already returned stays in use.
      });
    return () => {
      cancelled = true;
    };
  }, [cliAgentId, cliModels]);


  const setCliChoice = (patch: { model?: string; effort?: string }) => {
    if (!cliAgentId) return;
    void updateSettings({
      ai: {
        ...settings.ai,
        cliModels: {
          ...(settings.ai.cliModels ?? {}),
          [cliAgentId]: { ...cliChoice, ...patch },
        },
      },
    });
  };

  const send = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || turn || !hasBridge()) return;

    setError('');
    if (agent.startsWith('cli:')) {
      // The CLI runs in the granted workspace; without one there is nowhere
      // for it to work, and the main process would refuse anyway.
      if (!workspace?.configured) {
        setError(locale === 'zh'
          ? '命令行 Agent 需要先授权一个办公目录，它只在该目录内工作。'
          : 'A CLI agent needs a granted Office folder — it only works inside that folder.');
        return;
      }
    } else {
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
    }

    const requestId = crypto.randomUUID();
    const currentTurn = createTurnState(requestId);
    turnRef.current = currentTurn;
    setTurn(currentTurn);
    setDraft('');
    setHistoryOpen(false);
    // Tool trails ride on assistant messages so follow-ups still see what ran;
    // then trim so a long session stays inside the model window.
    const history = trimHistory(historyWithToolMemory(messages));
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: prompt },
    ]);

    try {
      // Fallback grant if the strip effect has not finished yet.
      let workspaceStatus = workspace;
      if (
        !workspaceStatus?.configured
        && activeDocument?.path
        && hasBridge()
      ) {
        try {
          workspaceStatus = await bridge().grantAiWorkspaceForPath(activeDocument.path);
          setWorkspace(workspaceStatus);
          setWorkspaceSource('document');
        } catch {
          // Keep going; the model will be told tools are unavailable.
        }
      }

      const workspacePath = workspaceStatus?.path || '';

      // Flush dirty editor state so LibreOffice tools match what the user sees.
      if (
        activeDocument?.editor
        && activeDocument.engineModified
        && activeDocument.path
      ) {
        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              window.clearTimeout(timeout);
              unsubscribe();
              if (error) reject(error);
              else resolve();
            };
            const timeout = window.setTimeout(() => {
              finish(new Error(locale === 'zh'
                ? '保存当前文档超时，请先手动保存后再试。'
                : 'Timed out saving the open document. Save manually and try again.'));
            }, 20000);
            const unsubscribe = bridge().onEditorSaved((payload) => {
              if (payload.sessionId !== activeDocument.editor?.sessionId) return;
              useApp.getState().engineSaved(payload);
              finish();
            });
            void useApp.getState().requestEngineSave(activeDocument.id);
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setTurn(null);
          turnRef.current = null;
          return;
        }
      }

      const activeOffice = buildActiveOffice(
        useApp.getState().documents.find((d) => d.id === activeDocument?.id) ?? activeDocument,
        workspacePath,
      );
      // Seed focus from the open tab when nothing has been written yet, so a
      // second message like "继续" still names a path for the model.
      const memoryForTurn: SessionMemory = sessionMemory.focusPath || !activeOffice?.relativePath
        ? sessionMemory
        : { ...sessionMemory, focusPath: activeOffice.relativePath };

      const officeContext: AiOfficeContext = {
        workspacePath,
        activeOffice,
        sessionMemory: memoryForTurn,
      };

      const result = await bridge().runAiTurn({
        requestId,
        prompt,
        agent,
        history,
        locale,
        files: buildTurnFiles(activeDocument),
        officeContext,
      });
      const completed = turnRef.current;
      const response = result.message || completed?.assistantText || '';
      // A CLI can exit cleanly having printed nothing. Saying so beats an empty
      // bubble, which reads as the assistant having ignored the request.
      const shown = response.trim() === ''
        ? (locale === 'zh'
            ? '（这一轮没有任何输出。命令行 Agent 有时会因为权限不足而直接结束——把上方权限切到「自动模式」再试一次。）'
            : '(This turn produced no output. A CLI agent sometimes exits without acting when it lacks permission — switch the access control above to Automatic and try again.)')
        : response;
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: shown,
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
  }, [activeDocument, agent, draft, locale, messages, persistHistory, sessionMemory, turn, workspace]);

  return (
    <aside
      className={`${open ? 'flex' : 'hidden'} h-full w-[440px] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-right-4 duration-200`}
      aria-label={t('aiAssistant', locale)}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3">
        <IconPlate icon={Bot} tone="accent" size="sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-[13px] leading-tight font-semibold tracking-tight">
            {t('aiAssistant', locale)}
          </h2>
          <span className="truncate font-mono text-[10px] leading-tight text-[var(--text-muted)]">
            {/* What will run the next turn — the CLI when one is chosen, not
                the model provider it is not going to use. */}
            {selectedCliAgent?.name || config?.model || t('aiNoModelShort', locale)}
          </span>
        </div>

        {/* A bordered control with an icon and a caret: as a bare coloured chip
            nobody read it as something they could change. */}
        {(() => {
          const badge = PERMISSION_BADGES[permissionMode];
          const ModeIcon = badge.icon;
          return (
            <div
              className={`relative flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 ${badge.className}`}
              title={badge.hint[locale]}
            >
              <ModeIcon size={14} className="shrink-0" />
              <span className="text-[12px] font-medium whitespace-nowrap">{badge.label[locale]}</span>
              <ChevronDown size={11} className="shrink-0 opacity-70" />
              <select
                value={permissionMode}
                aria-label={locale === 'zh' ? '权限模式' : 'Permission mode'}
                onChange={(event) => void updateSettings({
                  ai: {
                    ...settings.ai,
                    permissionMode: event.target.value as 'observer' | 'confirm' | 'auto',
                  },
                })}
                className="absolute inset-0 cursor-pointer opacity-0"
              >
                {(['observer', 'confirm', 'auto'] as const).map((mode) => (
                  <option key={mode} value={mode}>{PERMISSION_BADGES[mode].label[locale]}</option>
                ))}
              </select>
            </div>
          );
        })()}

        {[
          {
            id: 'automations',
            Icon: Workflow,
            active: automationOpen,
            label: locale === 'zh' ? '自动化任务' : 'Automations',
            toggle: () => {
              setAutomationOpen((current) => !current);
              setHistoryOpen(false);
            },
          },
          {
            id: 'history',
            Icon: BookOpen,
            active: historyOpen,
            label: locale === 'zh' ? '任务历史' : 'Task history',
            toggle: () => {
              setHistoryOpen((current) => !current);
              setAutomationOpen(false);
            },
          },
        ].map(({ id, Icon, active, label, toggle }) => (
          <button
            key={id}
            type="button"
            disabled={Boolean(turn)}
            onClick={toggle}
            aria-label={label}
            title={label}
            aria-pressed={active}
            className={`rounded-lg p-1.5 transition-colors disabled:opacity-50 ${
              active
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Icon size={15} />
          </button>
        ))}
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t('aiOpenSettings', locale)}
          title={t('aiOpenSettings', locale)}
          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <Settings size={15} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          aria-label={t('close', locale)}
        >
          <X size={15} />
        </button>
      </header>

      {/* Context strip — everything the next turn is allowed to touch, in one line each. */}
      <div className="shrink-0 space-y-1.5 border-b border-[var(--border-subtle)] px-3 py-2">
        {activeDocument && (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--accent-soft)] px-2 py-1.5">
            <FileText size={13} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--accent)]">
              {activeDocument.name}
            </span>
          </div>
        )}
        {activeDocument?.editor && (
          <p className="px-0.5 text-[10px] leading-snug text-[var(--text-muted)]">
            {t('aiInPlaceHint', locale)}
          </p>
        )}

        {workspace?.configured ? (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-sunken)] px-2 py-1.5">
            <FolderOpen size={13} className="shrink-0 text-[var(--success)]" />
            <div className="min-w-0 flex-1">
              <p className="text-[9.5px] leading-tight text-[var(--text-muted)]">
                {workspaceSource === 'document'
                  ? t('aiWorkspaceFromDocument', locale)
                  : t('aiWorkspaceLabel', locale)}
              </p>
              <p className="truncate text-[11px] leading-tight font-medium" title={workspace.path}>
                {workspace.path}
              </p>
            </div>
            <button
              type="button"
              disabled={Boolean(turn)}
              onClick={() => void chooseWorkspace()}
              className="rounded-md px-1.5 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
              title={t('aiWorkspaceChoose', locale)}
            >
              {locale === 'zh' ? '更换' : 'Change'}
            </button>
            <button
              type="button"
              disabled={Boolean(turn)}
              onClick={() => void clearWorkspace()}
              className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
              aria-label={t('aiWorkspaceClear', locale)}
              title={t('aiWorkspaceClear', locale)}
            >
              <X size={12} />
            </button>
          </div>
        ) : workspaceSyncing ? (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-sunken)] px-2 py-1.5">
            <Loader2 size={13} className="shrink-0 animate-spin text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
              {t('aiWorkspaceSyncing', locale)}
            </span>
          </div>
        ) : activeDocument && !activeDocument.path ? (
          <div className="space-y-1.5">
            <p className="px-0.5 text-[10px] leading-snug text-[var(--text-muted)]">
              {t('aiWorkspaceSaveFirst', locale)}
            </p>
            <button
              type="button"
              disabled={Boolean(turn)}
              onClick={() => void chooseWorkspace()}
              title={t('aiWorkspaceHint', locale)}
              className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] px-2 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              <FolderOpen size={13} className="shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
                {t('aiWorkspaceChoose', locale)}
              </span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={Boolean(turn)}
            onClick={() => void chooseWorkspace()}
            title={t('aiWorkspaceHint', locale)}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] px-2 py-1.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <FolderOpen size={13} className="shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
              {t('aiWorkspaceChoose', locale)}
            </span>
          </button>
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
            onRemove={(entryId) => void removeHistoryEntry(entryId)}
            onReuse={(entry) => {
              setDraft(entry.prompt);
              setHistoryOpen(false);
            }}
          />
        )}
        {!historyOpen && !automationOpen && messages.length === 0 && !turn && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <IconPlate icon={Sparkles} tone="accent" size="lg" className="mb-3" />
            <p className="text-[15px] font-medium tracking-tight">{t('aiEmpty', locale)}</p>
            <p className="mt-2 max-w-[19rem] text-[12px] leading-relaxed text-[var(--text-muted)]">
              {t('aiEmptyHint', locale)}
            </p>
            {config?.model ? (
              <div className="mt-5 flex w-full flex-col gap-1.5">
                {SUGGESTIONS[locale].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setDraft(suggestion)}
                    className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : (
              <Button size="sm" variant="primary" className="mt-4" onClick={onOpenSettings}>
                {t('aiOpenSettings', locale)}
              </Button>
            )}
          </div>
        )}

        <div className="space-y-4">
          {!historyOpen && !automationOpen && messages.map((message) => (
            <div
              key={message.id}
              className={message.role === 'user' ? 'flex justify-end' : 'flex flex-col'}
            >
              {message.role === 'user' ? (
                <div className="max-w-[88%] rounded-2xl bg-[var(--surface-sunken)] px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
                  {message.content}
                </div>
              ) : (
                <div
                  className={message.error
                    ? 'rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--danger)]'
                    : 'min-w-0'}
                >
                  {message.workflow && <WorkflowPreview steps={message.workflow} locale={locale} />}
                  {message.tools && <ToolActivities tools={message.tools} locale={locale} />}
                  {message.error ? (
                    message.content
                  ) : (
                    <div
                      className={PROSE}
                      dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(message.content || '') }}
                    />
                  )}
                  {message.artifacts && (
                    <ArtifactActions files={message.artifacts} locale={locale} onPreviewFile={onPreviewFile} />
                  )}
                </div>
              )}
            </div>
          ))}

          {!historyOpen && !automationOpen && turn && (
            <div className="min-w-0">
              <WorkflowPreview steps={turn.workflow} locale={locale} />
              <ToolActivities tools={turn.tools} locale={locale} />
              {turn.assistantText ? (
                <div
                  className={PROSE}
                  dangerouslySetInnerHTML={{ __html: renderAssistantMarkdown(turn.assistantText) }}
                />
              ) : turn.approvals.length === 0 ? (
                <ActivityIndicator label={t('aiThinking', locale)} />
              ) : null}

              {turn.approvals.map((approval) => (
                <div
                  key={approval.approvalId}
                  className="mt-2 overflow-hidden rounded-xl border border-[var(--warning)] bg-[var(--warning-soft)]"
                >
                  <div className="flex items-start gap-2.5 px-2.5 py-2.5">
                    <IconPlate icon={ShieldCheck} tone="warning" size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-semibold text-[var(--warning)]">
                        {t('aiApprovalTitle', locale)}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)]">
                        {localized(approval.toolName, locale) || approval.toolId}
                        {approval.inputFileNames.length > 0
                          ? ` · ${approval.inputFileNames.join(', ')}`
                          : ''}
                      </p>
                    </div>
                  </div>
                  {approval.details && (
                    <pre className="mx-2.5 max-h-32 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                      {approval.details}
                    </pre>
                  )}
                  <div className="flex w-full min-w-0 items-stretch gap-1.5 p-2.5">
                    <button
                      type="button"
                      onClick={() => void bridge().respondAiApproval(turn.requestId, approval.approvalId, false)}
                      className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-xl border border-[var(--danger)]/35 px-1.5 text-[11px] font-semibold text-[var(--danger)] transition-colors hover:border-[var(--danger)]/60 hover:bg-[var(--danger-soft)]"
                    >
                      <X size={12} className="shrink-0" />
                      <span className="truncate">{t('aiDeny', locale)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void bridge().respondAiApproval(turn.requestId, approval.approvalId, true)}
                      className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-xl border border-[var(--success)]/35 px-1.5 text-[11px] font-semibold text-[var(--success)] transition-colors hover:border-[var(--success)]/60 hover:bg-[var(--success-soft)]"
                    >
                      <Check size={12} className="shrink-0" />
                      <span className="truncate">{t('aiApprove', locale)}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {(officeApprovals.length > 0 || officeApprovalRecords.length > 0) && (
        <div className="mx-3 mb-2 space-y-1.5">
          {officeApprovals.map((request) => (
            <OfficeApprovalCard
              key={request.approvalId}
              request={request}
              locale={locale}
              onAnswer={onAnswerOfficeApproval}
            />
          ))}
          <OfficeApprovalTrail records={officeApprovalRecords} locale={locale} />
        </div>
      )}

      {error && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] px-2.5 py-2 text-[11px] text-[var(--danger)]">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1 leading-relaxed break-words">{error}</span>
          <button type="button" onClick={onOpenSettings} className="shrink-0 font-medium underline">
            {t('aiOpenSettings', locale)}
          </button>
        </div>
      )}

      {!automationOpen && (
        <div className="shrink-0 border-t border-[var(--border-subtle)] p-3">
          <div className="overflow-hidden rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] transition-[border-color,box-shadow] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_15%,transparent)]">
            <textarea
              value={draft}
              rows={3}
              disabled={Boolean(turn)}
              placeholder={t('aiPlaceholder', locale)}
              className="w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[15px] leading-[1.55] outline-none placeholder:text-[15px] placeholder:text-[var(--text-muted)] disabled:opacity-60"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {/* The controls stay put while a turn runs: replacing them with a
                spinner moved everything under the cursor and hid what the turn
                was configured with. The stop button already says it is busy. */}
            <div className="flex items-end justify-between gap-2 px-3 pt-1 pb-2.5">
                <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1">
                  <button
                    type="button"
                    onClick={() => setAgentMenuOpen((current) => !current)}
                    className="flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                    title={locale === 'zh' ? '选择执行方式' : 'Choose what runs this turn'}
                  >
                    {selectedCliAgent ? (
                      <VendorMark
                        iconId={agent}
                        fallback={selectedCliAgent.name.charAt(0)}
                        tone="indigo"
                        size="sm"
                        className="h-4 w-4 rounded-md"
                      />
                    ) : (
                      <Sparkles size={11} className="shrink-0" />
                    )}
                    <span className="truncate">
                      {selectedCliAgent?.name || config?.model || t('aiNoModelShort', locale)}
                    </span>
                    <ChevronDown size={10} className="shrink-0 opacity-60" />
                  </button>

                  {/* Model and effort belong to a CLI turn: each CLI takes its
                      own model ids and its own levels. An API provider's model
                      and effort are part of that provider, and are configured
                      with it in Settings rather than per message. */}
                  {selectedCliAgent && modelChoices.length > 0 && (
                    <select
                      value={cliChoice.model}
                      aria-label={locale === 'zh' ? '模型' : 'Model'}
                      title={locale === 'zh' ? '模型' : 'Model'}
                      onChange={(event) => setCliChoice({ model: event.target.value })}
                      className="max-w-[13rem] shrink-0 truncate rounded-lg bg-transparent px-2 py-1 text-[11px] text-[var(--text-muted)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                    >
                      <option value="">{locale === 'zh' ? '模型：默认' : 'Model: default'}</option>
                      {modelChoices.map((entry) => (
                        <option key={entry.id} value={entry.id}>{entry.name}</option>
                      ))}
                    </select>
                  )}

                  {selectedCliAgent && selectedCliAgent.effortLevels.length > 0 && (
                    <select
                      value={cliChoice.effort}
                      aria-label={locale === 'zh' ? '推理档位' : 'Effort'}
                      title={locale === 'zh' ? '推理档位' : 'Effort'}
                      onChange={(event) => setCliChoice({ effort: event.target.value })}
                      className="shrink-0 rounded-lg bg-transparent px-2 py-1 text-[11px] text-[var(--text-muted)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                    >
                      <option value="">{locale === 'zh' ? '档位：默认' : 'Effort: default'}</option>
                      {selectedCliAgent.effortLevels.map((level) => (
                        <option key={level} value={level}>{level}</option>
                      ))}
                    </select>
                  )}

                  {agentMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setAgentMenuOpen(false)} />
                      <div className="absolute bottom-full left-0 z-50 mb-1 max-h-72 w-[19rem] overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1 shadow-[var(--shadow-card)]">
                        <button
                          type="button"
                          onClick={() => {
                            setAgent('');
                            setAgentMenuOpen(false);
                          }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
                        >
                          <IconPlate icon={Sparkles} tone={agent ? 'neutral' : 'accent'} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] font-medium">
                              {locale === 'zh' ? '内置模型' : 'Built-in model'}
                            </span>
                            <span className="block truncate text-[10px] text-[var(--text-muted)]">
                              {config?.model || t('aiNoModelShort', locale)}
                            </span>
                          </span>
                          {!agent && <Check size={12} className="shrink-0 text-[var(--accent)]" />}
                        </button>

                        {cliAgents.map((entry) => {
                          const id = `cli:${entry.id}`;
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              onClick={() => {
                                setAgent(id);
                                setAgentMenuOpen(false);
                              }}
                              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
                            >
                              <VendorMark
                                iconId={id}
                                fallback={entry.name.charAt(0)}
                                tone={agent === id ? 'indigo' : 'slate'}
                                size="sm"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12px] font-medium">{entry.name}</span>
                                <span className="block truncate text-[10px] text-[var(--text-muted)]">
                                  {entry.mcpInstalled
                                    ? (locale === 'zh' ? '已接入本机工具' : 'Local tools connected')
                                    : (locale === 'zh' ? '未接入 MCP，只能用它自己的工具' : 'No MCP — its own tools only')}
                                </span>
                              </span>
                              {agent === id && <Check size={12} className="shrink-0 text-[var(--accent)]" />}
                            </button>
                          );
                        })}

                        <p className="border-t border-[var(--border-subtle)] px-3 pt-2 pb-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">
                          {locale === 'zh'
                            ? '命令行负责规划；Office 操作走 magies-office（Magies 执行）。上方权限模式会限制写入——授权目录后选「自动」即可少打断地全线接管。'
                            : 'CLI plans; Magies runs Office tools (magies-office MCP). App permission mode gates writes — Automatic for hands-off takeover after you grant a folder.'}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              {turn ? (
                <button
                  type="button"
                  onClick={() => void bridge().cancelAiTurn(turn.requestId)}
                  aria-label={t('aiStop', locale)}
                  title={t('aiStop', locale)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--surface-panel)] transition-[background-color,transform] active:scale-[0.97]"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!draft.trim() || !hasBridge()}
                  onClick={() => void send()}
                  aria-label={t('aiSend', locale)}
                  title={t('aiSend', locale)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--surface-panel)] transition-[background-color,transform] hover:opacity-90 active:scale-[0.97] disabled:bg-[var(--surface-sunken)] disabled:text-[var(--text-muted)]"
                >
                  <ArrowUp size={15} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
