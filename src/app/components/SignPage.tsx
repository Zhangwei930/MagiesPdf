import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { bridge } from '../bridge.ts';
import type { PickedFile } from '../bridge.ts';
import { formatBytes, localized, t } from '../i18n.ts';
import { Check, Eraser, FileText, FolderOpen, Save, ToolIcon } from '../icons.ts';
import { useApp } from '../store.ts';
import { FileDrop } from './FileDrop.tsx';
import { ParamForm } from './ParamForm.tsx';
import { Button, ProgressBar } from './ui.tsx';

interface SignPageProps {
  tool: ToolMeta;
  onBack(): void;
}

/** Params that stay on the dedicated panel (mode/source), not the generic form. */
const HIDDEN_PARAM_KEYS = new Set(['mode']);

export function SignPage({ tool }: SignPageProps) {
  const locale = useApp((s) => s.locale);
  const runTool = useApp((s) => s.runTool);
  const cancelJob = useApp((s) => s.cancelJob);
  const markJobSaved = useApp((s) => s.markJobSaved);
  const jobs = useApp((s) => s.jobs);

  const [pdfFiles, setPdfFiles] = useState<PickedFile[]>([]);
  const [imageFiles, setImageFiles] = useState<PickedFile[]>([]);
  const [source, setSource] = useState<'draw' | 'image' | 'text'>('draw');
  const [values, setValues] = useState<ParamValues>(() => {
    const base = defaultParams(tool.params);
    return { ...base, mode: 'image' };
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState('');
  const [hasInk, setHasInk] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  const job = useMemo(() => jobs.find((j) => j.id === jobId), [jobs, jobId]);
  const busy = job?.status === 'queued' || job?.status === 'running';

  const formParams = useMemo(
    () =>
      tool.params.filter((param) => {
        if (HIDDEN_PARAM_KEYS.has(param.key)) return false;
        // Hide image-only noise when typing; keep position/pages always.
        if (source === 'text' && param.key === 'widthPercent') return true;
        return true;
      }),
    [source, tool.params],
  );

  const selectSource = (next: 'draw' | 'image' | 'text') => {
    setSource(next);
    setValues((prev) => ({
      ...prev,
      mode: next === 'text' ? 'text' : 'image',
    }));
  };

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || source !== 'draw') return;
    // Size once; CSS scales for display.
    if (canvas.width === 0) {
      canvas.width = 600;
      canvas.height = 200;
    }
    clearCanvas();
  }, [clearCanvas, source]);

  const pointerPos = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.setPointerCapture(event.pointerId);
    drawing.current = true;
    lastPoint.current = pointerPos(event);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !lastPoint.current) return;
    const next = pointerPos(event);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    lastPoint.current = next;
    setHasInk(true);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    drawing.current = false;
    lastPoint.current = null;
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
  };

  const canvasToPngFile = async (): Promise<PickedFile> => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error('canvas missing');
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('toBlob failed'))), 'image/png');
    });
    const buffer = new Uint8Array(await blob.arrayBuffer());
    return {
      name: 'signature.png',
      path: '',
      size: buffer.length,
      mime: 'image/png',
      bytes: buffer,
    };
  };

  const canRun = (() => {
    if (pdfFiles.length !== 1) return false;
    if (source === 'draw') return hasInk;
    if (source === 'image') return imageFiles.length === 1;
    if (source === 'text') return String(values.signerName ?? '').trim() !== '';
    return false;
  })();

  const run = useCallback(async () => {
    const pdf = pdfFiles[0];
    if (!pdf) return;
    setSavedTo('');

    let files: PickedFile[] = [pdf];
    let params: ParamValues = { ...values };

    if (source === 'draw') {
      files = [pdf, await canvasToPngFile()];
      params = { ...params, mode: 'image' };
    } else if (source === 'image') {
      const image = imageFiles[0];
      if (!image) return;
      files = [pdf, image];
      params = { ...params, mode: 'image' };
    } else {
      params = { ...params, mode: 'text' };
    }

    setJobId(await runTool(tool, files, params));
  }, [imageFiles, pdfFiles, runTool, source, tool, values]);

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
        <section className="surface-panel p-4">
          <h2 className="mb-3 text-[13px] font-semibold text-[var(--text-secondary)]">
            {t('signSource', locale)}
          </h2>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['draw', 'signDraw'],
                ['image', 'signImage'],
                ['text', 'signText'],
              ] as const
            ).map(([value, labelKey]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() => selectSource(value)}
                className={
                  source === value
                    ? 'rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 text-[13px] text-[var(--accent)]'
                    : 'rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                }
              >
                {t(labelKey, locale)}
              </button>
            ))}
          </div>
        </section>

        <FileDrop
          spec={{ accept: ['.pdf'], min: 1, max: 1 }}
          files={pdfFiles}
          locale={locale}
          onChange={setPdfFiles}
        />

        {source === 'draw' && (
          <section className="surface-panel space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-[var(--text-secondary)]">
                {t('signDrawPad', locale)}
              </h2>
              <Button size="sm" variant="ghost" disabled={busy} onClick={clearCanvas}>
                <Eraser size={14} />
                {t('signClear', locale)}
              </Button>
            </div>
            <canvas
              ref={canvasRef}
              className="h-[140px] w-full cursor-crosshair touch-none rounded-lg border border-[var(--border-subtle)] bg-white"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            />
            <p className="text-[12px] text-[var(--text-muted)]">{t('signDrawHint', locale)}</p>
          </section>
        )}

        {source === 'image' && (
          <FileDrop
            spec={{ accept: ['.png', '.jpg', '.jpeg'], min: 1, max: 1 }}
            files={imageFiles}
            locale={locale}
            onChange={setImageFiles}
          />
        )}

        <section className="surface-panel p-4">
          <h2 className="mb-3.5 text-[13px] font-semibold text-[var(--text-secondary)]">
            {t('options', locale)}
          </h2>
          <ParamForm
            params={formParams}
            values={values}
            locale={locale}
            disabled={busy}
            onChange={setValues}
          />
        </section>

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
            <ul className="divide-y divide-[var(--border-subtle)]">
              {job.result.files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center gap-2.5 px-4 py-2.5">
                  <FileText size={14} className="text-[var(--accent)]" />
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
        <div className="flex-1" />
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
