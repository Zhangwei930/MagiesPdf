import { useCallback, useMemo, useState } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { bridge } from '../bridge.ts';
import type { JobResult, PickedFile } from '../bridge.ts';
import { formatBytes, localized, t } from '../i18n.ts';
import { AlertCircle, Check, Eye, FileText, FolderOpen, Save } from '../icons.ts';
import { useApp } from '../store.ts';
import { FileDrop } from './FileDrop.tsx';
import { ParamForm } from './ParamForm.tsx';
import { ToolWindow } from './ToolWindow.tsx';
import { Button, ProgressBar } from './ui.tsx';

interface ToolPageProps {
  tool: ToolMeta;
  onBack(): void;
  initialFile?: PickedFile;
  onPreviewFile?(file: PickedFile): void;
}

/**
 * Standalone tool entry (no open PDF tab): WPS-style centered window instead of
 * a full-page form. Options stay compact; 确定 / 取消 sit in a fixed footer.
 */
export function ToolPage({ tool, onBack, initialFile, onPreviewFile }: ToolPageProps) {
  const locale = useApp((s) => s.locale);
  const runTool = useApp((s) => s.runTool);
  const cancelJob = useApp((s) => s.cancelJob);
  const markJobSaved = useApp((s) => s.markJobSaved);
  const jobs = useApp((s) => s.jobs);

  const [files, setFiles] = useState<PickedFile[]>(() => (initialFile ? [initialFile] : []));
  const [values, setValues] = useState<ParamValues>(() => defaultParams(tool.params));
  const [jobId, setJobId] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState('');

  const job = useMemo(() => jobs.find((j) => j.id === jobId), [jobs, jobId]);
  const busy = job?.status === 'queued' || job?.status === 'running';
  const done = job?.status === 'done' && job.result;
  const needsFiles = !(tool.input.min === 0 && tool.input.max === 0);
  const enoughFiles = files.length >= tool.input.min;

  const run = useCallback(async () => {
    setSavedTo('');
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
    <ToolWindow
      title={tool.name[locale]}
      subtitle={tool.description[locale]}
      icon={tool.icon}
      locale={locale}
      busy={busy}
      size={tool.params.length > 4 ? 'md' : 'sm'}
      onClose={onBack}
      footer={
        done && job.result ? (
          <>
            <Button size="sm" variant="ghost" onClick={onBack}>
              {t('close', locale)}
            </Button>
            {job.result.files.length > 0 && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const outputs = job.result?.files;
                  if (outputs) void saveAll(outputs);
                }}
              >
                <Save size={12} />
                {t('saveAll', locale)}
              </Button>
            )}
          </>
        ) : busy ? (
          <Button size="sm" variant="danger" onClick={() => job && void cancelJob(job.id)}>
            {t('cancel', locale)}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onBack}>
              {t('cancel', locale)}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!enoughFiles}
              onClick={() => void run()}
            >
              {t('pdfTaskOk', locale)}
            </Button>
          </>
        )
      }
    >
      {needsFiles && (
        <FileDrop
          spec={tool.input}
          files={files}
          locale={locale}
          density="compact"
          onChange={setFiles}
          onPreview={onPreviewFile}
        />
      )}

      {tool.params.length > 0 && (
        <ParamForm
          params={tool.params}
          values={values}
          locale={locale}
          disabled={busy}
          density="compact"
          onChange={setValues}
        />
      )}

      {job && <JobStatusCard job={job} onCancel={() => void cancelJob(job.id)} />}

      {done && job.result && (
        <ResultsCard
          result={job.result}
          savedTo={savedTo}
          onSaveAll={() => {
            const outputs = job.result?.files;
            if (outputs) void saveAll(outputs);
          }}
          onPreview={onPreviewFile}
        />
      )}
    </ToolWindow>
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
      <section className="flex items-start gap-2 rounded-lg border border-[var(--danger)] bg-[var(--danger-soft)] px-2.5 py-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--danger)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-[var(--danger)]">
            {localized(job.error?.userMessage, locale)}
          </p>
          {job.error?.message && (
            <p className="mt-1 font-mono text-[10px] break-all text-[var(--text-muted)]">
              {job.error.code}: {job.error.message}
            </p>
          )}
        </div>
      </section>
    );
  }

  if (job.status === 'cancelled') {
    return (
      <section className="rounded-lg bg-[var(--surface-sunken)] px-2.5 py-2 text-[12px] text-[var(--text-secondary)]">
        {t('cancelled', locale)}
      </section>
    );
  }

  if (job.status === 'done') return null;

  return (
    <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
          {localized(job.message, locale) || t(job.status === 'queued' ? 'queued' : 'running', locale)}
        </p>
        <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
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
  onPreview,
}: {
  result: JobResult;
  savedTo: string;
  onSaveAll(): void;
  onPreview?(file: PickedFile): void;
}) {
  const locale = useApp((s) => s.locale);
  const reportRows = asReportRows(result.data);

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)]">
      <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2">
        <Check size={13} className="shrink-0 text-[var(--success)]" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[12px] font-semibold">{t('results', locale)}</h3>
          {result.summary && (
            <p className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)]">
              {result.summary[locale]}
            </p>
          )}
        </div>
        {result.files.length > 0 && (
          <Button size="sm" variant="primary" onClick={onSaveAll}>
            <Save size={12} />
            {t('saveAll', locale)}
          </Button>
        )}
      </header>

      {reportRows && (
        <dl className="divide-y divide-[var(--border-subtle)]">
          {reportRows.map((row, index) => (
            <div key={index} className="flex gap-3 px-2.5 py-1.5">
              <dt className="w-24 shrink-0 text-[11px] text-[var(--text-muted)]">
                {row.label[locale]}
              </dt>
              <dd className="min-w-0 flex-1 text-[12px] break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <ul className="max-h-40 divide-y divide-[var(--border-subtle)] overflow-y-auto">
        {result.files.map((file, index) => (
          <li key={`${file.name}-${index}`} className="group flex items-center gap-2 px-2.5 py-1.5">
            <FileText size={12} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 flex-1 truncate text-[12px]">{file.name}</span>
            <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
              {formatBytes(file.bytes.length, locale)}
            </span>
            {onPreview && file.name.toLowerCase().endsWith('.pdf') && (
              <button
                type="button"
                aria-label={t('previewPdf', locale)}
                onClick={() =>
                  onPreview({
                    name: file.name,
                    path: '',
                    size: file.bytes.length,
                    mime: file.mime,
                    bytes: file.bytes,
                  })
                }
                className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:text-[var(--accent)]"
              >
                <Eye size={12} />
              </button>
            )}
            <button
              type="button"
              onClick={() => void bridge().saveOutputAs(file)}
              className="shrink-0 rounded px-1 py-0.5 text-[11px] text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--accent)]"
            >
              {t('saveAs', locale)}
            </button>
          </li>
        ))}
      </ul>

      {savedTo && (
        <footer className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--success-soft)] px-2.5 py-1.5">
          <Check size={12} className="shrink-0 text-[var(--success)]" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-secondary)]">
            {t('savedTo', locale)} {savedTo}
          </span>
          <button
            type="button"
            onClick={() => void bridge().revealPath(savedTo)}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
          >
            <FolderOpen size={11} />
            {t('reveal', locale)}
          </button>
        </footer>
      )}
    </section>
  );
}
