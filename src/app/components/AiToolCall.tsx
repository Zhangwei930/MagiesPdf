import { useState } from 'react';
import { clsx } from 'clsx';
import { localized, type Locale } from '../i18n.ts';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileOutput,
  FilePenLine,
  LayoutGrid,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from '../icons.ts';
import type { AiToolActivity } from '../ai/chatState.ts';
import { ProgressBar } from './ui.tsx';
import { AiSpinner, IconPlate, type Tone } from './settingsUi.tsx';

/**
 * One tool call, drawn the way MagiesTerminal draws them: a plate, the tool's
 * name, a status mark, and everything else folded away until asked for. The
 * arguments matter when something went wrong and are noise the rest of the time.
 */

/** The icon comes from the tool's category; the tint comes from its status. */
function toolIcon(toolId: string): LucideIcon {
  const category = toolId.split('.')[0];
  switch (category) {
    case 'convert': return FileOutput;
    case 'organize': return LayoutGrid;
    case 'edit': return FilePenLine;
    case 'security': return ShieldCheck;
    case 'read': return BookOpen;
    default: return Wrench;
  }
}

const STATUS_TONE: Record<AiToolActivity['status'], Tone> = {
  running: 'accent',
  done: 'success',
  error: 'danger',
};

export function ToolCallCard({ tool, locale }: { tool: AiToolActivity; locale: Locale }) {
  const [open, setOpen] = useState(false);
  const name = localized(tool.toolName, locale) || tool.toolId;
  const hasDetail = Boolean(tool.details || tool.error);

  return (
    <div
      className={clsx(
        'overflow-hidden rounded-xl border bg-[var(--surface-panel)]',
        tool.status === 'error' ? 'border-[var(--danger)]' : 'border-[var(--border-subtle)]',
      )}
    >
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:hover:bg-transparent"
      >
        {hasDetail ? (
          open ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--accent)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--text-muted)]" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {tool.status === 'running' ? (
          <span className="ai-plate h-7 w-7 rounded-lg bg-[var(--accent-soft)]">
            <AiSpinner size="sm" />
          </span>
        ) : (
          <IconPlate icon={toolIcon(tool.toolId)} tone={STATUS_TONE[tool.status]} size="md" className="h-7 w-7 rounded-lg" />
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium">{name}</span>
          {tool.inputFileNames.length > 0 && (
            <span className="block truncate font-mono text-[10px] text-[var(--text-muted)]">
              {tool.inputFileNames.join(', ')}
            </span>
          )}
        </span>

        {tool.status !== 'running' && (
          <span
            className={clsx(
              'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
              tool.status === 'done'
                ? 'bg-[var(--success-soft)] text-[var(--success)]'
                : 'bg-[var(--danger-soft)] text-[var(--danger)]',
            )}
          >
            {tool.status === 'done'
              ? (locale === 'zh' ? '完成' : 'Done')
              : (locale === 'zh' ? '失败' : 'Failed')}
          </span>
        )}
      </button>

      {tool.status === 'running' && (
        <div className="px-2.5 pb-2">
          <ProgressBar value={tool.fraction} />
        </div>
      )}

      {open && hasDetail && (
        <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
          {tool.details && (
            <div className="px-2.5 py-2">
              <div className="mb-1.5 text-[9.5px] font-semibold tracking-wider text-[var(--text-muted)] uppercase">
                {locale === 'zh' ? '参数' : 'Arguments'}
              </div>
              <pre className="max-h-56 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                {tool.details}
              </pre>
            </div>
          )}
          {tool.error && (
            <div className="border-t border-[var(--border-subtle)] px-2.5 py-2">
              <div className="mb-1 text-[9.5px] font-semibold tracking-wider text-[var(--text-muted)] uppercase">
                {locale === 'zh' ? '错误' : 'Error'}
              </div>
              <p className="text-[11px] leading-relaxed break-words text-[var(--danger)]">{tool.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
