import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { bridge } from '../bridge.ts';
import type { PickedFile } from '../bridge.ts';
import { formatBytes, localized, t } from '../i18n.ts';
import { Check, Eraser, FileText, FolderOpen, Save } from '../icons.ts';
import { useApp } from '../store.ts';
import { FileDrop } from './FileDrop.tsx';
import { ParamForm } from './ParamForm.tsx';
import { ToolWindow } from './ToolWindow.tsx';
import { Button, ProgressBar } from './ui.tsx';

interface SignPageProps {
  tool: ToolMeta;
  onBack(): void;
}

/** Params that stay on the dedicated panel (mode/source), not the generic form. */
const HIDDEN_PARAM_KEYS = new Set(['mode']);

export function SignPage({ tool, onBack }: SignPageProps) {
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

  const done = job?.status === 'done' && job.result;

  return (
    <ToolWindow
      title={tool.name[locale]}
      subtitle={tool.description[locale]}
      icon={tool.icon}
      locale={locale}
      busy={busy}
      size="md"
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
            <Button size="sm" variant="primary" disabled={!canRun} onClick={() => void run()}>
              {t('pdfTaskOk', locale)}
            </Button>
          </>
        )
      }
    >
      <section className="space-y-2">
        <h3 className="text-[12px] font-semibold text-[var(--text-secondary)]">
          {t('signSource', locale)}
        </h3>
        <div className="grid grid-cols-3 gap-1">
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
                  ? 'rounded-md border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-1.5 text-[12px] font-medium text-[var(--accent)]'
                  : 'rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[12px] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
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
        density="compact"
        onChange={setPdfFiles}
      />

      {source === 'draw' && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[12px] font-semibold text-[var(--text-secondary)]">
              {t('signDrawPad', locale)}
            </h3>
            <Button size="sm" variant="ghost" disabled={busy} onClick={clearCanvas}>
              <Eraser size={13} />
              {t('signClear', locale)}
            </Button>
          </div>
          <canvas
            ref={canvasRef}
            className="h-[120px] w-full cursor-crosshair touch-none rounded-lg border border-[var(--border-subtle)] bg-white"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
          <p className="text-[11px] text-[var(--text-muted)]">{t('signDrawHint', locale)}</p>
        </section>
      )}

      {source === 'image' && (
        <FileDrop
          spec={{ accept: ['.png', '.jpg', '.jpeg'], min: 1, max: 1 }}
          files={imageFiles}
          locale={locale}
          density="compact"
          onChange={setImageFiles}
        />
      )}

      <ParamForm
        params={formParams}
        values={values}
        locale={locale}
        disabled={busy}
        density="compact"
        onChange={setValues}
      />

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
          <ul className="divide-y divide-[var(--border-subtle)]">
            {job.result.files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="flex items-center gap-2 px-2.5 py-1.5">
                <FileText size={12} className="text-[var(--accent)]" />
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
