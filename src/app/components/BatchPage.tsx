import { useCallback, useMemo, useState } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { uiRegistry } from '../catalog.ts';
import { bridge } from '../bridge.ts';
import type { PickedFile } from '../bridge.ts';
import { formatBytes, localized, t } from '../i18n.ts';
import { Check, FileText, FolderOpen, Save, ToolIcon } from '../icons.ts';
import { useApp } from '../store.ts';
import { FileDrop } from './FileDrop.tsx';
import { ParamForm } from './ParamForm.tsx';
import { Button, ProgressBar } from './ui.tsx';

interface BatchPageProps {
  tool: ToolMeta;
  onBack(): void;
}

export function BatchPage({ tool }: BatchPageProps) {
  const locale = useApp((s) => s.locale);
  const runTool = useApp((s) => s.runTool);
  const cancelJob = useApp((s) => s.cancelJob);
  const markJobSaved = useApp((s) => s.markJobSaved);
  const jobs = useApp((s) => s.jobs);

  const targets = useMemo(
    () =>
      uiRegistry
        .pipelineTools()
        .filter((entry) => entry.input.max === 1 && entry.id !== tool.id),
    [tool.id],
  );

  const [targetId, setTargetId] = useState(
    () => targets.find((entry) => entry.id === 'security.add-watermark')?.id ?? targets[0]?.id ?? '',
  );
  const target = uiRegistry.tryGet(targetId);
  const [params, setParams] = useState<ParamValues>(() =>
    target ? defaultParams(target.params) : {},
  );
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [folderNote, setFolderNote] = useState('');

  const job = useMemo(() => jobs.find((j) => j.id === jobId), [jobs, jobId]);
  const busy = job?.status === 'queued' || job?.status === 'running';
  const enoughFiles = files.length >= 1;

  const selectTarget = (id: string) => {
    setTargetId(id);
    const next = uiRegistry.tryGet(id);
    setParams(next ? defaultParams(next.params) : {});
  };

  const run = useCallback(async () => {
    if (!targetId) return;
    setSavedTo('');
    setJobId(
      await runTool(tool, files, {
        toolId: targetId,
        toolParams: JSON.stringify(params),
      }),
    );
  }, [files, params, runTool, targetId, tool]);

  const saveAll = useCallback(
    async (outputs: ToolOutputFile[]) => {
      const result = await bridge().saveOutputs(outputs);
      if (!result) return;
      setSavedTo(result.directory);
      if (jobId) markJobSaved(jobId, result.directory);
    },
    [jobId, markJobSaved],
  );

  // FileDrop should accept whatever the target tool accepts when known.
  const dropSpec = target?.input ?? tool.input;

  const addFolder = async () => {
    setFolderNote('');
    const result = await bridge().pickFolderFiles(dropSpec.accept, recursive);
    if (!result.directory || result.files.length === 0) {
      if (result.directory) {
        setFolderNote(
          locale === 'zh' ? '该文件夹中没有匹配的文件。' : 'No matching files in that folder.',
        );
      }
      return;
    }
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.path || f.name));
      const merged = [...prev];
      for (const file of result.files) {
        const key = file.path || file.name;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(file);
      }
      return merged;
    });
    setFolderNote(
      `${t('batchFolderLoaded', locale)} ${result.files.length}` +
        (result.truncated ? ` — ${t('batchFolderTruncated', locale)}` : ''),
    );
  };

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
        <section className="surface-panel space-y-3 p-4">
          <h2 className="text-[13px] font-semibold text-[var(--text-secondary)]">
            {t('batchTargetTool', locale)}
          </h2>
          <select
            className="field-input text-[13px]"
            value={targetId}
            disabled={busy}
            onChange={(e) => selectTarget(e.target.value)}
          >
            {targets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name[locale]}
              </option>
            ))}
          </select>
          {target && (
            <p className="text-[12px] text-[var(--text-muted)]">{target.description[locale]}</p>
          )}
        </section>

        <section className="surface-panel space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void addFolder()}>
              <FolderOpen size={14} />
              {t('batchAddFolder', locale)}
            </Button>
            <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={recursive}
                disabled={busy}
                onChange={(e) => setRecursive(e.target.checked)}
              />
              {t('batchRecursive', locale)}
            </label>
          </div>
          {folderNote && <p className="text-[12px] text-[var(--text-muted)]">{folderNote}</p>}
        </section>

        <FileDrop spec={dropSpec} files={files} locale={locale} onChange={setFiles} />

        {target && target.params.length > 0 && (
          <section className="surface-panel p-4">
            <h2 className="mb-3.5 text-[13px] font-semibold text-[var(--text-secondary)]">
              {t('options', locale)}
            </h2>
            <ParamForm
              params={target.params}
              values={params}
              locale={locale}
              disabled={busy}
              onChange={setParams}
            />
          </section>
        )}

        {job && job.status !== 'done' && (
          <section className="surface-panel space-y-2.5 p-4">
            {job.status === 'error' ? (
              <p className="text-[13px] text-[var(--danger)]">
                {localized(job.error?.userMessage, locale)}
              </p>
            ) : job.status === 'cancelled' ? (
              <p className="text-[13px]">{t('cancelled', locale)}</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-[13px] text-[var(--text-secondary)]">
                    {localized(job.message, locale) || t('running', locale)}
                  </p>
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    {Math.round(job.fraction * 100)}%
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void cancelJob(job.id)}>
                    {t('cancel', locale)}
                  </Button>
                </div>
                <ProgressBar value={job.fraction} />
              </>
            )}
          </section>
        )}

        {job?.status === 'done' && job.result && (
          <section className="surface-panel overflow-hidden">
            <header className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4 py-3">
              <Check size={15} className="text-[var(--success)]" />
              <div className="min-w-0 flex-1">
                <h2 className="text-[13px] font-semibold">{t('results', locale)}</h2>
                {job.result.summary && (
                  <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)]">
                    {job.result.summary[locale]}
                  </p>
                )}
              </div>
              {job.result.files.length > 0 && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const outputs = job.result?.files;
                    if (outputs) void saveAll(outputs);
                  }}
                >
                  <Save size={13} />
                  {t('saveAll', locale)}
                </Button>
              )}
            </header>
            {savedTo && (
              <p className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] px-4 py-2 text-[12px] text-[var(--text-secondary)]">
                <FolderOpen size={12} />
                {t('savedTo', locale)} {savedTo}
              </p>
            )}
            <ul className="max-h-64 divide-y divide-[var(--border-subtle)] overflow-y-auto">
              {job.result.files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center gap-2.5 px-4 py-2.5">
                  <FileText size={14} className="shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{file.name}</span>
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    {formatBytes(file.bytes.length, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] px-6 py-3">
        <div className="flex-1 text-[12px] text-[var(--text-muted)]">
          {files.length} {t('fileCount', locale)}
          {target ? ` · ${target.name[locale]}` : ''}
        </div>
        {busy ? (
          <Button variant="secondary" onClick={() => job && void cancelJob(job.id)}>
            {t('cancel', locale)}
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          disabled={!enoughFiles || !targetId}
          onClick={() => void run()}
        >
          {t(busy ? 'running' : 'run', locale)}
        </Button>
      </footer>
    </div>
  );
}
