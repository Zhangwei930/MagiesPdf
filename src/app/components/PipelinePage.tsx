import { useCallback, useMemo, useState } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { uiRegistry } from '../catalog.ts';
import { bridge, type PipelinePreset } from '../bridge.ts';
import type { PickedFile } from '../bridge.ts';
import { formatBytes, localized, t } from '../i18n.ts';
import { BUILTIN_PIPELINE_PRESETS } from '../pipelinePresets.ts';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Plus,
  Save,
  Trash2,
  ToolIcon,
} from '../icons.ts';
import { useApp } from '../store.ts';
import { FileDrop } from './FileDrop.tsx';
import { ParamForm } from './ParamForm.tsx';
import { Button, Field, ProgressBar } from './ui.tsx';

interface PipelinePageProps {
  tool: ToolMeta;
  onBack(): void;
}

interface StepDraft {
  id: string;
  toolId: string;
  params: ParamValues;
  open: boolean;
}

function newStep(toolId: string): StepDraft {
  const meta = uiRegistry.tryGet(toolId);
  return {
    id: crypto.randomUUID(),
    toolId,
    params: meta ? defaultParams(meta.params) : {},
    open: true,
  };
}

export function PipelinePage({ tool }: PipelinePageProps) {
  const locale = useApp((s) => s.locale);
  const runTool = useApp((s) => s.runTool);
  const cancelJob = useApp((s) => s.cancelJob);
  const markJobSaved = useApp((s) => s.markJobSaved);
  const jobs = useApp((s) => s.jobs);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const presets = settings.pipelinePresets ?? [];

  const palette = useMemo(
    () =>
      uiRegistry
        .pipelineTools()
        .filter((entry) => entry.id !== 'advanced.pipeline' && entry.id !== 'advanced.batch'),
    [],
  );

  const [files, setFiles] = useState<PickedFile[]>([]);
  const [steps, setSteps] = useState<StepDraft[]>(() => [
    newStep(palette[0]?.id ?? 'organize.rotate'),
  ]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetNotice, setPresetNotice] = useState('');

  const job = useMemo(() => jobs.find((j) => j.id === jobId), [jobs, jobId]);
  const busy = job?.status === 'queued' || job?.status === 'running';
  const enoughFiles = files.length >= tool.input.min;
  const canRun = enoughFiles && steps.length > 0 && steps.every((s) => uiRegistry.has(s.toolId));

  const updateStep = (id: string, patch: Partial<StepDraft>) => {
    setSteps((list) => list.map((step) => (step.id === id ? { ...step, ...patch } : step)));
  };

  const stepsPayload = useCallback(
    () =>
      steps.map((step) => ({
        toolId: step.toolId,
        params: step.params as Record<string, unknown>,
      })),
    [steps],
  );

  const loadPreset = (preset: PipelinePreset) => {
    setSteps(
      preset.steps.map((step) => {
        const meta = uiRegistry.tryGet(step.toolId);
        return {
          id: crypto.randomUUID(),
          toolId: step.toolId,
          params: {
            ...(meta ? defaultParams(meta.params) : {}),
            ...(step.params as ParamValues),
          },
          open: true,
        };
      }),
    );
    setPresetName(preset.name);
    setPresetNotice('');
  };

  const savePreset = async () => {
    const name = presetName.trim() || `Pipeline ${new Date().toLocaleString()}`;
    const existing = presets.find((preset) => preset.name === name);
    const next: PipelinePreset = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      steps: stepsPayload(),
      updatedAt: Date.now(),
    };
    const pipelinePresets = existing
      ? presets.map((preset) => (preset.id === existing.id ? next : preset))
      : [next, ...presets].slice(0, 40);
    await updateSettings({ pipelinePresets });
    setPresetNotice(t('pipelinePresetSaved', locale));
  };

  const deletePreset = async (id: string) => {
    await updateSettings({
      pipelinePresets: presets.filter((preset) => preset.id !== id),
    });
  };

  const exportPreset = async () => {
    const name = presetName.trim() || 'pipeline';
    const payload = {
      version: 1,
      kind: 'magiespdf.pipeline-preset',
      name,
      steps: stepsPayload(),
      exportedAt: new Date().toISOString(),
    };
    const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`);
    const safe = name.replace(/[/\\:*?"<>|]+/g, '_').slice(0, 80) || 'pipeline';
    await bridge().saveOutputAs({
      name: `${safe}.pipeline.json`,
      bytes,
      mime: 'application/json',
    });
  };

  const importPreset = async () => {
    setPresetNotice('');
    const picked = await bridge().pickFiles(['.json'], false);
    const file = picked[0];
    if (!file) return;
    try {
      const text = new TextDecoder().decode(file.bytes);
      const parsed = JSON.parse(text) as {
        kind?: string;
        name?: string;
        steps?: Array<{ toolId: string; params?: Record<string, unknown> }>;
      };
      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        throw new Error('no steps');
      }
      for (const step of parsed.steps) {
        if (!step || typeof step.toolId !== 'string') throw new Error('bad step');
      }
      loadPreset({
        id: crypto.randomUUID(),
        name: typeof parsed.name === 'string' && parsed.name ? parsed.name : file.name,
        steps: parsed.steps.map((step) => ({
          toolId: step.toolId,
          params: step.params ?? {},
        })),
        updatedAt: Date.now(),
      });
      setPresetNotice(t('pipelineImportOk', locale));
    } catch {
      setPresetNotice(t('pipelineImportBad', locale));
    }
  };

  const run = useCallback(async () => {
    setSavedTo('');
    setJobId(
      await runTool(tool, files, {
        steps: JSON.stringify(stepsPayload()),
      }),
    );
  }, [files, runTool, stepsPayload, tool]);

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
        <FileDrop spec={tool.input} files={files} locale={locale} onChange={setFiles} />

        <section className="surface-panel space-y-3 p-4">
          <h2 className="text-[13px] font-semibold text-[var(--text-secondary)]">
            {t('pipelinePresets', locale)}
          </h2>
          <Field label={t('pipelinePresetName', locale)}>
            <div className="flex gap-2">
              <input
                className="field-input text-[13px]"
                value={presetName}
                disabled={busy}
                placeholder="e.g. Compress + watermark"
                onChange={(e) => setPresetName(e.target.value)}
              />
              <Button size="sm" disabled={busy || steps.length === 0} onClick={() => void savePreset()}>
                <Save size={13} />
                {t('pipelineSavePreset', locale)}
              </Button>
            </div>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || steps.length === 0}
              onClick={() => void exportPreset()}
            >
              {t('pipelineExport', locale)}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void importPreset()}>
              {t('pipelineImport', locale)}
            </Button>
          </div>
          {presetNotice && (
            <p
              className={
                presetNotice === t('pipelineImportBad', locale)
                  ? 'text-[12px] text-[var(--danger)]'
                  : 'text-[12px] text-[var(--success)]'
              }
            >
              {presetNotice}
            </p>
          )}

          <div>
            <h3 className="mb-1.5 text-[12px] font-semibold text-[var(--text-muted)]">
              {t('pipelineBuiltinPresets', locale)}
            </h3>
            <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
              {BUILTIN_PIPELINE_PRESETS.map((preset) => (
                <li key={preset.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{preset.name}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">
                      {preset.steps.length} {t('pipelineStepCount', locale)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => loadPreset(preset)}
                  >
                    {t('pipelineLoadPreset', locale)}
                  </Button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-1.5 text-[12px] font-semibold text-[var(--text-muted)]">
              {t('pipelinePresets', locale)}
            </h3>
            {presets.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted)]">{t('pipelinePresetEmpty', locale)}</p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
                {presets.map((preset) => (
                  <li key={preset.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{preset.name}</p>
                      <p className="text-[11px] text-[var(--text-muted)]">
                        {preset.steps.length} {t('pipelineStepCount', locale)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => loadPreset(preset)}
                    >
                      {t('pipelineLoadPreset', locale)}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void deletePreset(preset.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between px-0.5">
            <h2 className="text-[13px] font-semibold text-[var(--text-secondary)]">
              {t('pipelineSteps', locale)}
            </h2>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || palette.length === 0}
              onClick={() =>
                setSteps((list) => [...list, newStep(palette[0]?.id ?? 'organize.rotate')])
              }
            >
              <Plus size={14} />
              {t('pipelineAddStep', locale)}
            </Button>
          </div>

          {steps.map((step, index) => {
            const meta = uiRegistry.tryGet(step.toolId);
            return (
              <div key={step.id} className="surface-panel overflow-hidden">
                <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--surface-sunken)] font-mono text-[11px] text-[var(--text-muted)]">
                    {index + 1}
                  </span>
                  <select
                    className="field-input min-w-0 flex-1 text-[13px]"
                    value={step.toolId}
                    disabled={busy}
                    onChange={(e) => {
                      const toolId = e.target.value;
                      const next = uiRegistry.tryGet(toolId);
                      updateStep(step.id, {
                        toolId,
                        params: next ? defaultParams(next.params) : {},
                        open: true,
                      });
                    }}
                  >
                    {palette.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name[locale]}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="px-2"
                    disabled={busy}
                    onClick={() => updateStep(step.id, { open: !step.open })}
                    aria-label={step.open ? 'collapse' : 'expand'}
                  >
                    {step.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="px-2"
                    disabled={busy || steps.length <= 1}
                    onClick={() => setSteps((list) => list.filter((s) => s.id !== step.id))}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
                {step.open && meta && meta.params.length > 0 && (
                  <div className="p-4">
                    <ParamForm
                      params={meta.params}
                      values={step.params}
                      locale={locale}
                      disabled={busy}
                      onChange={(params) => updateStep(step.id, { params })}
                    />
                  </div>
                )}
                {step.open && meta && meta.params.length === 0 && (
                  <p className="px-4 py-3 text-[12px] text-[var(--text-muted)]">
                    {t('pipelineNoParams', locale)}
                  </p>
                )}
              </div>
            );
          })}
        </section>

        {job && <MiniJobStatus job={job} onCancel={() => void cancelJob(job.id)} />}

        {job?.status === 'done' && job.result && (
          <MiniResults
            result={job.result}
            savedTo={savedTo}
            onSaveAll={() => {
              const outputs = job.result?.files;
              if (outputs) void saveAll(outputs);
            }}
          />
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] px-6 py-3">
        <div className="flex-1 text-[12px] text-[var(--text-muted)]">
          {steps.length} {t('pipelineStepCount', locale)}
        </div>
        {busy ? (
          <Button variant="secondary" onClick={() => job && void cancelJob(job.id)}>
            {t('cancel', locale)}
          </Button>
        ) : null}
        <Button variant="primary" size="lg" loading={busy} disabled={!canRun} onClick={() => void run()}>
          {t(busy ? 'running' : 'run', locale)}
        </Button>
      </footer>
    </div>
  );
}

function MiniJobStatus({
  job,
  onCancel,
}: {
  job: NonNullable<ReturnType<typeof useApp.getState>['jobs'][number]>;
  onCancel(): void;
}) {
  const locale = useApp((s) => s.locale);
  if (job.status === 'done') return null;
  if (job.status === 'error') {
    return (
      <section className="rounded-[var(--radius-card)] border border-[var(--danger)] bg-[var(--danger-soft)] p-4 text-[13px] text-[var(--danger)]">
        {localized(job.error?.userMessage, locale)}
      </section>
    );
  }
  if (job.status === 'cancelled') {
    return (
      <section className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-3 text-[13px]">
        {t('cancelled', locale)}
      </section>
    );
  }
  return (
    <section className="surface-panel space-y-2.5 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-[13px] text-[var(--text-secondary)]">
          {localized(job.message, locale) || t('running', locale)}
        </p>
        <span className="font-mono text-xs text-[var(--text-muted)]">
          {Math.round(job.fraction * 100)}%
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('cancel', locale)}
        </Button>
      </div>
      <ProgressBar value={job.fraction} />
    </section>
  );
}

function MiniResults({
  result,
  savedTo,
  onSaveAll,
}: {
  result: NonNullable<ReturnType<typeof useApp.getState>['jobs'][number]['result']>;
  savedTo: string;
  onSaveAll(): void;
}) {
  const locale = useApp((s) => s.locale);
  return (
    <section className="surface-panel overflow-hidden">
      <header className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4 py-3">
        <Check size={15} className="text-[var(--success)]" />
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
      {savedTo && (
        <p className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] px-4 py-2 text-[12px] text-[var(--text-secondary)]">
          <FolderOpen size={12} />
          {t('savedTo', locale)} {savedTo}
        </p>
      )}
      <ul className="max-h-64 divide-y divide-[var(--border-subtle)] overflow-y-auto">
        {result.files.map((file, index) => (
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
  );
}
