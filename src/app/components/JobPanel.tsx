import { clsx } from 'clsx';
import { bridge } from '../bridge.ts';
import { localized, t } from '../i18n.ts';
import { AlertCircle, Ban, Check, FolderOpen, Loader2, Trash2, X } from '../icons.ts';
import { activeJobCount, useApp, type JobEntry } from '../store.ts';
import { Button, EmptyState, ProgressBar } from './ui.tsx';

export function JobPanel({ open, onClose }: { open: boolean; onClose(): void }) {
  const locale = useApp((s) => s.locale);
  const jobs = useApp((s) => s.jobs);
  const clearFinished = useApp((s) => s.clearFinishedJobs);

  if (!open) return null;

  const finished = jobs.length - activeJobCount(jobs);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <div className="flex-1 bg-black/25" onClick={onClose} role="presentation" />

      <aside
        className="flex w-full max-w-sm flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-2xl"
        role="dialog"
        aria-label={t('jobs', locale)}
      >
        <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
          <h2 className="flex-1 text-sm font-semibold">{t('jobs', locale)}</h2>
          {finished > 0 && (
            <Button size="sm" variant="ghost" onClick={clearFinished}>
              <Trash2 size={13} />
              {t('clearFinished', locale)}
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('cancel', locale)}
            className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X size={15} />
          </button>
        </header>

        {jobs.length === 0 ? (
          <EmptyState icon={Loader2} title={t('noJobs', locale)} />
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

const STATUS_ICON = {
  queued: Loader2,
  running: Loader2,
  done: Check,
  error: AlertCircle,
  cancelled: Ban,
} as const;

const STATUS_TONE = {
  queued: 'text-[var(--text-muted)]',
  running: 'text-[var(--accent)]',
  done: 'text-[var(--success)]',
  error: 'text-[var(--danger)]',
  cancelled: 'text-[var(--text-muted)]',
} as const;

function JobRow({ job }: { job: JobEntry }) {
  const locale = useApp((s) => s.locale);
  const cancelJob = useApp((s) => s.cancelJob);
  const markJobSaved = useApp((s) => s.markJobSaved);

  const Icon = STATUS_ICON[job.status];
  const active = job.status === 'queued' || job.status === 'running';

  const save = async () => {
    if (!job.result) return;
    const result = await bridge().saveOutputs(job.result.files);
    if (result) markJobSaved(job.id, result.directory);
  };

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <Icon
          size={14}
          className={clsx('mt-0.5 shrink-0', STATUS_TONE[job.status], active && 'animate-spin')}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{job.toolName[locale]}</p>
          <p className="truncate text-[11px] text-[var(--text-muted)]" title={job.fileNames.join(', ')}>
            {job.fileNames.join(', ')}
          </p>
        </div>
        {active && (
          <button
            type="button"
            onClick={() => void cancelJob(job.id)}
            className="shrink-0 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--danger)]"
          >
            {t('cancel', locale)}
          </button>
        )}
      </div>

      {active && <ProgressBar value={job.fraction} />}

      {job.status === 'error' && (
        <p className="text-[11px] leading-relaxed text-[var(--danger)]">
          {localized(job.error?.userMessage, locale)}
        </p>
      )}

      {job.status === 'done' && job.result && (
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate text-[11px] text-[var(--text-secondary)]">
            {localized(job.result.summary, locale) ||
              `${job.result.files.length} ${t('fileCount', locale)}`}
          </span>
          {job.savedTo ? (
            <button
              type="button"
              onClick={() => void bridge().revealPath(job.savedTo!)}
              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
            >
              <FolderOpen size={11} />
              {t('reveal', locale)}
            </button>
          ) : (
            <button
              type="button"
              onClick={save}
              className="shrink-0 text-[11px] text-[var(--accent)] hover:underline"
            >
              {t('saveAll', locale)}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
