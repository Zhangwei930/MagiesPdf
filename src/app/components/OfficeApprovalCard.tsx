import { useEffect, useRef } from 'react';
import type { OfficeToolApproval } from '../bridge.ts';
import {
  approvalSubject,
  type ApprovalDecision,
  type OfficeApprovalRecord,
} from '../ai/officeApprovals.ts';
import { t, type Locale } from '../i18n.ts';
import { Check, FileText, ShieldCheck, X } from '../icons.ts';
import { Button } from './ui.tsx';

/**
 * One pending Confirm-mode approval, drawn in the AI panel where the user is
 * already watching the agent work.
 *
 * Follows Magies Terminal's approval card: the request is stated in words
 * before the function name, the target is shown, and the three answers sit in
 * one row with Enter and Escape bound to the two the user reaches for most.
 */
export function OfficeApprovalCard({
  request,
  locale,
  onAnswer,
}: {
  request: OfficeToolApproval;
  locale: Locale;
  onAnswer(approvalId: string, decision: ApprovalDecision): void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const allowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    const focus = window.setTimeout(() => allowRef.current?.focus(), 80);
    return () => window.clearTimeout(focus);
  }, [request.approvalId]);

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onAnswer(request.approvalId, 'once');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onAnswer(request.approvalId, 'deny');
        }
      }}
      className="rounded-xl border border-[var(--warning,#d97706)]/45 bg-[linear-gradient(135deg,rgba(217,119,6,0.10),transparent)] p-3 outline-none"
      role="group"
      aria-label={t('officeApprovalTitle', locale)}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--warning,#d97706)]/35 bg-[var(--warning,#d97706)]/15 text-[var(--warning,#d97706)]">
          <ShieldCheck size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold leading-tight">
            {approvalSubject(request.functionName, locale === 'zh' ? 'zh' : 'en')}
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-[var(--text-muted)]">
            {t('officeApprovalHint', locale)}
          </p>
          {request.path && (
            <p className="mt-1.5 flex items-center gap-1 truncate text-[11px] text-[var(--text-secondary)]">
              <FileText size={11} className="shrink-0 text-[var(--text-muted)]" />
              {request.path}
            </p>
          )}
          <p className="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]">
            {request.functionName}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 flex-1 px-2 text-[11px]"
          onClick={() => onAnswer(request.approvalId, 'deny')}
        >
          <X size={12} />
          {t('officeApprovalDeny', locale)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 flex-1 px-2 text-[11px]"
          onClick={() => onAnswer(request.approvalId, 'session')}
        >
          {t('officeApprovalAlways', locale)}
        </Button>
        <Button
          ref={allowRef}
          size="sm"
          variant="primary"
          className="h-7 flex-1 px-2 text-[11px]"
          onClick={() => onAnswer(request.approvalId, 'once')}
        >
          <Check size={12} />
          {t('officeApprovalOnce', locale)}
        </Button>
      </div>
      <p className="mt-1.5 text-center text-[9px] text-[var(--text-muted)]">
        {t('officeApprovalKeys', locale)}
      </p>
    </div>
  );
}

/** What was decided, and why a later call may not have asked again. */
export function OfficeApprovalTrail({
  records,
  locale,
}: {
  records: OfficeApprovalRecord[];
  locale: Locale;
}) {
  if (records.length === 0) return null;
  const label: Record<OfficeApprovalRecord['decision'], { zh: string; en: string }> = {
    once: { zh: '允许一次', en: 'Allowed once' },
    session: { zh: '本次运行全部允许', en: 'Allowed for this run' },
    deny: { zh: '已拒绝', en: 'Denied' },
    timeout: { zh: '超时未处理，已拒绝', en: 'Timed out, denied' },
  };
  const tone: Record<OfficeApprovalRecord['decision'], string> = {
    once: 'text-[var(--success)]',
    session: 'text-[var(--success)]',
    deny: 'text-[var(--danger)]',
    timeout: 'text-[var(--text-muted)]',
  };
  return (
    <details className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5">
      <summary className="cursor-pointer select-none text-[10px] text-[var(--text-muted)]">
        {t('officeApprovalTrail', locale)} · {records.length}
      </summary>
      <ul className="mt-1.5 space-y-1">
        {records.map((record) => (
          <li key={record.approvalId} className="flex items-baseline gap-1.5 text-[10px]">
            <span className={`shrink-0 font-medium ${tone[record.decision]}`}>
              {locale === 'zh' ? label[record.decision].zh : label[record.decision].en}
            </span>
            <span className="truncate font-mono text-[var(--text-muted)]">
              {record.functionName}
            </span>
            {record.path && (
              <span className="truncate text-[var(--text-secondary)]">{record.path}</span>
            )}
            <span className="ml-auto shrink-0 text-[var(--text-muted)]">
              {new Date(record.at).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US')}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
