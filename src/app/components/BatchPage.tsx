import { useCallback, useMemo, useState } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { uiRegistry } from '../catalog.ts';
import { bridge } from '../bridge.ts';
import type { PickedFile } from '../bridge.ts';
import { formatBytes, localized, t } from '../i18n.ts';
import { Check, FileText, FolderOpen, Save } from '../icons.ts';
import { useApp } from '../store.ts';
import { FileDrop } from './FileDrop.tsx';
import { ParamForm } from './ParamForm.tsx';
import { ToolWindow } from './ToolWindow.tsx';
import { Button, ProgressBar } from './ui.tsx';

interface BatchPageProps {
  tool: ToolMeta;
  onBack(): void;
}

export function BatchPage({ tool, onBack }: BatchPageProps) {
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

  const done = job?.status === 'done' && job.result;

  return (
    <ToolWindow
      title={tool.name[locale]}
      subtitle={tool.description[locale]}
      icon={tool.icon}
      locale={locale}
      busy={busy}
      size="lg"
      onClose={onBack}
      footer={
        done && job.result ? (
          <>
            <span className="mr-auto text-[11px] text-[var(--text-muted)]">
              {files.length} {t('fileCount', locale)}
              {target ? ` · ${target.name[locale]}` : ''}
            </span>
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
            <span className="mr-auto text-[11px] text-[var(--text-muted)]">
              {files.length} {t('fileCount', locale)}
              {target ? ` · ${target.name[locale]}` : ''}
            </span>
            <Button size="sm" variant="ghost" onClick={onBack}>
              {t('cancel', locale)}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!enoughFiles || !targetId}
              onClick={() => void run()}
            >
              {t('pdfTaskOk', locale)}
            </Button>
          </>
        )
      }
    >
      <section className="space-y-2">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)]">
          {t('batchTargetTool', locale)}
        </h3>
        <select
          className="field-input text-[12px]"
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
          <p className="text-[11px] text-[var(--text-muted)]">{target.description[locale]}</p>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void addFolder()}>
            <FolderOpen size={13} />
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
        {folderNote && <p className="text-[11px] text-[var(--text-muted)]">{folderNote}</p>}
      </section>

      <FileDrop
        spec={dropSpec}
        files={files}
        locale={locale}
        density="compact"
        onChange={setFiles}
      />

      {target && target.params.length > 0 && (
        <ParamForm
          params={target.params}
          values={params}
          locale={locale}
          disabled={busy}
          density="compact"
          onChange={setParams}
        />
      )}

      {job && job.status !== 'done' && (
        <section className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5">
          {job.status === 'error' ? (
            <p className="text-[12px] text-[var(--danger)]">
              {localized(job.error?.userMessage, locale)}
            </p>
          ) : job.status === 'cancelled' ? (
            <p className="text-[12px]">{t('cancelled', locale)}</p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[12px] text-[var(--text-secondary)]">
                  {localized(job.message, locale) || t('running', locale)}
                </p>
                <span className="font-mono text-[11px] text-[var(--text-muted)]">
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
        <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)]">
          <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2">
            <Check size={13} className="text-[var(--success)]" />
            <div className="min-w-0 flex-1">
              <h3 className="text-[12px] font-semibold">{t('results', locale)}</h3>
              {job.result.summary && (
                <p className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)]">
                  {job.result.summary[locale]}
                </p>
              )}
            </div>
          </header>
          {savedTo && (
            <p className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]">
              <FolderOpen size={11} />
              {t('savedTo', locale)} {savedTo}
            </p>
          )}
          <ul className="max-h-40 divide-y divide-[var(--border-subtle)] overflow-y-auto">
            {job.result.files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="flex items-center gap-2 px-2.5 py-1.5">
                <FileText size={12} className="shrink-0 text-[var(--accent)]" />
                <span className="min-w-0 flex-1 truncate text-[12px]">{file.name}</span>
                <span className="font-mono text-[10px] text-[var(--text-muted)]">
                  {formatBytes(file.bytes.length, locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </ToolWindow>
  );
}
