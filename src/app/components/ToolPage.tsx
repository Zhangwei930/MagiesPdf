import { useCallback, useMemo, useState } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { bridge } from '../bridge.ts';
import type { JobResult, PickedFile } from '../bridge.ts';
import { formatBytes, localized, t } from '../i18n.ts';
import { AlertCircle, Check, FileText, FolderOpen, Save, ToolIcon } from '../icons.ts';
import { useApp } from '../store.ts';
import { FileDrop } from './FileDrop.tsx';
import { ParamForm } from './ParamForm.tsx';
import { Button, ProgressBar } from './ui.tsx';

interface ToolPageProps {
  tool: ToolMeta;
  onBack(): void;
}

export function ToolPage({ tool }: ToolPageProps) {
  const locale = useApp((s) => s.locale);
  const runTool = useApp((s) => s.runTool);
  const cancelJob = useApp((s) => s.cancelJob);
  const markJobSaved = useApp((s) => s.markJobSaved);
  const jobs = useApp((s) => s.jobs);

  const [files, setFiles] = useState<PickedFile[]>([]);
  const [values, setValues] = useState<ParamValues>(() => defaultParams(tool.params));
  const [jobId, setJobId] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState('');

  const job = useMemo(() => jobs.find((j) => j.id === jobId), [jobs, jobId]);
  const busy = job?.status === 'queued' || job?.status === 'running';
  const needsFiles = !(tool.input.min === 0 && tool.input.max === 0);
  const enoughFiles = files.length >= tool.input.min;

  const run = useCallback(async () => {
    setSavedTo('');
    // runTool returns the job id immediately so Cancel is available while running.
    setJobId(await runTool(tool, files, values));
  }, [files, runTool, tool, values]);

  const saveAll = useCallback(
    async (outputs: ToolOutputFile[]) => {
      const result = await bridge().saveOutputs(outputs);
      if (!result) return;
      setSavedTo(result.directory);
      if (jobId) markJobSaved(jobId, result.directory);
    },
    [jobId, markJobSaved],
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
      <header className="flex items-start gap-3 px-6 pt-5 pb-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)]">
          <ToolIcon name={tool.icon} size={19} className="text-[var(--accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight">{tool.name[locale]}</h1>
          <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {tool.description[locale]}
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
        {needsFiles && (
          <FileDrop spec={tool.input} files={files} locale={locale} onChange={setFiles} />
        )}

        {tool.params.length > 0 && (
          <section className="surface-panel p-4">
            <h2 className="mb-3.5 text-[13px] font-semibold text-[var(--text-secondary)]">
              {t('options', locale)}
            </h2>
            <ParamForm
              params={tool.params}
              values={values}
              locale={locale}
              disabled={busy}
              onChange={setValues}
            />
          </section>
        )}

        {job && <JobStatusCard job={job} onCancel={() => void cancelJob(job.id)} />}

        {job?.status === 'done' && job.result && (
          <ResultsCard
            result={job.result}
            savedTo={savedTo}
            onSaveAll={() => void saveAll(job.result!.files)}
          />
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] px-6 py-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setValues(defaultParams(tool.params))}
        >
          {t('reset', locale)}
        </Button>
        <div className="flex-1" />
        {busy ? (
          <Button variant="danger" size="lg" onClick={() => job && void cancelJob(job.id)}>
            {t('cancel', locale)}
          </Button>
        ) : (
          <Button variant="primary" size="lg" disabled={!enoughFiles} onClick={() => void run()}>
            {t('run', locale)}
          </Button>
        )}
      </footer>
    </div>
  );
}

function JobStatusCard({
  job,
  onCancel,
}: {
  job: NonNullable<ReturnType<typeof useApp.getState>['jobs'][number]>;
  onCancel(): void;
}) {
  const locale = useApp((s) => s.locale);

  if (job.status === 'error') {
    return (
      <section className="flex items-start gap-2.5 rounded-[var(--radius-card)] border border-[var(--danger)] bg-[var(--danger-soft)] p-4">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-[var(--danger)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-[var(--danger)]">
            {localized(job.error?.userMessage, locale)}
          </p>
          {job.error?.message && (
            <p className="mt-1.5 font-mono text-[11px] break-all text-[var(--text-muted)]">
              {job.error.code}: {job.error.message}
            </p>
          )}
        </div>
      </section>
    );
  }

  if (job.status === 'cancelled') {
    return (
      <section className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-3 text-[13px] text-[var(--text-secondary)]">
        {t('cancelled', locale)}
      </section>
    );
  }

  if (job.status === 'done') return null;

  return (
    <section className="surface-panel space-y-2.5 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-secondary)]">
          {localized(job.message, locale) || t(job.status === 'queued' ? 'queued' : 'running', locale)}
        </p>
        <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">
          {Math.round(job.fraction * 100)}%
        </span>
        <Button size="sm" variant="danger" onClick={onCancel}>
          {t('cancel', locale)}
        </Button>
      </div>
      <ProgressBar value={job.fraction} />
    </section>
  );
}

/** The labelled-row convention report tools emit — see `edit/getInfo.ts`. */
function asReportRows(data: unknown): Array<{ label: { zh: string; en: string }; value: string }> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const ok = data.every(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as { value?: unknown }).value === 'string' &&
      typeof (row as { label?: { zh?: unknown } }).label?.zh === 'string',
  );
  return ok ? (data as Array<{ label: { zh: string; en: string }; value: string }>) : null;
}

function ResultsCard({
  result,
  savedTo,
  onSaveAll,
}: {
  result: JobResult;
  savedTo: string;
  onSaveAll(): void;
}) {
  const locale = useApp((s) => s.locale);
  const reportRows = asReportRows(result.data);

  return (
    <section className="surface-panel overflow-hidden">
      <header className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4 py-3">
        <Check size={15} className="shrink-0 text-[var(--success)]" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">{t('results', locale)}</h2>
          {result.summary && (
            <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">
              {result.summary[locale]}
            </p>
          )}
        </div>
        {result.files.length > 0 && (
          <Button size="sm" variant="primary" onClick={onSaveAll}>
            <Save size={13} />
            {t('saveAll', locale)}
          </Button>
        )}
      </header>

      {reportRows && (
        <dl className="divide-y divide-[var(--border-subtle)]">
          {reportRows.map((row, index) => (
            <div key={index} className="flex gap-4 px-4 py-2">
              <dt className="w-28 shrink-0 text-[12px] text-[var(--text-muted)]">
                {row.label[locale]}
              </dt>
              <dd className="min-w-0 flex-1 text-[13px] break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <ul className="max-h-64 divide-y divide-[var(--border-subtle)] overflow-y-auto">
        {result.files.map((file, index) => (
          <li key={`${file.name}-${index}`} className="group flex items-center gap-2.5 px-4 py-2.5">
            <FileText size={14} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 flex-1 truncate text-[13px]">{file.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
              {formatBytes(file.bytes.length, locale)}
            </span>
            <button
              type="button"
              onClick={() => void bridge().saveOutputAs(file)}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--accent)]"
            >
              {t('saveAs', locale)}
            </button>
          </li>
        ))}
      </ul>

      {savedTo && (
        <footer className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--success-soft)] px-4 py-2.5">
          <Check size={13} className="shrink-0 text-[var(--success)]" />
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-secondary)]">
            {t('savedTo', locale)} {savedTo}
          </span>
          <button
            type="button"
            onClick={() => void bridge().revealPath(savedTo)}
            className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--accent)] hover:underline"
          >
            <FolderOpen size={12} />
            {t('reveal', locale)}
          </button>
        </footer>
      )}
    </section>
  );
}
