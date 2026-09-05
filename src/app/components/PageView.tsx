import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { Locale } from '../i18n.ts';
import { t } from '../i18n.ts';
import type { Point, Size } from '../pdf/geometry.ts';
import {
  getFormFields,
  renderPageToCanvas,
  renderTextLayer,
  type FormFieldBox,
  type PdfDocumentHandle,
} from '../pdf/renderer.ts';
import { DrawingOverlay } from './DrawingOverlay.tsx';
import type { InkAnnotation } from '../pdf/inkAnnotation.ts';

/** Beyond 2× the extra pixels cost memory without being visible. */
const MAX_DPR = 2;

function devicePixels(): number {
  return Math.min(MAX_DPR, window.devicePixelRatio || 1);
}

type ViewMode = 'view' | 'text' | 'redact' | 'stamp' | 'form' | 'draw';

/**
 * One page in the scroll column: its canvas, and whatever the current mode
 * overlays on it. Absolutely positioned at the offset the layout computed, so
 * the column's height never depends on what has finished rendering.
 */
export function PageView({
  doc,
  pageNumber,
  size,
  scale,
  locale,
  mode,
  modeEpoch,
  busy,
  panning,
  drafts,
  fields,
  top,
  epoch,
  hits,
  currentHits,
  inkAnnotations = [],
  nightMode,
  onGoToPage: _onGoToPage,
  onFields,
  onDraftChange,
  onRedact,
  onStamp,
  onText,
  onAddInkAnnotation,
}: {
  doc: PdfDocumentHandle;
  pageNumber: number;
  size: Size;
  scale: number;
  locale: Locale;
  mode: ViewMode;
  modeEpoch: number;
  busy: boolean;
  panning: boolean;
  nightMode?: boolean;
  onGoToPage?: (page: number) => void;
  drafts: Record<string, string>;
  fields: FormFieldBox[] | undefined;
  top: number;
  /** Bumped when this page's content changed; unchanged means keep the pixels. */
  epoch: number;
  /** Text-run indices on this page that a search matched. */
  hits: readonly number[];
  /** The subset of `hits` belonging to the match currently stepped to. */
  currentHits: readonly number[];
  inkAnnotations?: InkAnnotation[];
  onFields(source: PdfDocumentHandle, pageNumber: number, fields: FormFieldBox[]): void;
  onDraftChange(name: string, value: string): void;
  onRedact(pageNumber: number, from: Point, to: Point, box: Size): void;
  onStamp(pageNumber: number, at: Point, box: Size): void;
  onText(pageNumber: number, text: string, at: Point, box: Size): void;
  onAddInkAnnotation?(pageNumber: number, ink: Omit<InkAnnotation, 'id' | 'pageNumber'>): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  /** The span per text run, as returned by the last text-layer render. */
  const textDivs = useRef<HTMLElement[]>([]);
  const [textVersion, setTextVersion] = useState(0);
  const [marquee, setMarquee] = useState<{ from: Point; to: Point } | null>(null);
  const [textEditor, setTextEditor] = useState<{
    at: Point;
    value: string;
    epoch: number;
  } | null>(null);

  /**
   * What is currently on the canvas and in the text layer. An edit hands over a
   * new document object, but a page it did not touch is the same picture — so
   * this is what decides whether there is any work to do.
   */
  const drawn = useRef({ epoch: -1, scale: 0 });
  const laidOut = useRef({ epoch: -1, scale: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (drawn.current.epoch === epoch && drawn.current.scale === scale) return;

    let stale = false;
    void renderPageToCanvas(doc, pageNumber, canvas, scale, devicePixels(), () => stale)
      .then(() => {
        if (!stale) drawn.current = { epoch, scale };
      })
      .catch(() => {
        // A page that will not draw leaves the previous image up; the load
        // failure the document itself reports is the one worth surfacing.
      });
    return () => {
      stale = true;
    };
  }, [doc, epoch, pageNumber, scale]);

  // The text layer has to be laid out again at every zoom, since pdf.js sizes
  // the container from the scale rather than letting CSS stretch it.
  useEffect(() => {
    const container = textLayerRef.current;
    if (!container) return;
    if (laidOut.current.epoch === epoch && laidOut.current.scale === scale) return;

    let stale = false;
    void renderTextLayer(doc, pageNumber, container, scale)
      .then((divs) => {
        if (stale) return;
        laidOut.current = { epoch, scale };
        textDivs.current = divs;
        // Highlights are applied to these spans, so re-applying them has to
        // wait for the spans to exist.
        setTextVersion((version) => version + 1);
      })
      .catch(() => {
        // A page whose text will not extract is still readable and printable;
        // it simply cannot be selected or found.
      });
    return () => {
      stale = true;
    };
  }, [doc, epoch, pageNumber, scale]);

  useEffect(() => {
    const marked = new Set(hits);
    const current = new Set(currentHits);
    for (const [index, span] of textDivs.current.entries()) {
      span.classList.toggle('find-hit', marked.has(index) && !current.has(index));
      span.classList.toggle('find-hit-current', current.has(index));
    }
  }, [hits, currentHits, textVersion]);

  useEffect(() => {
    if (mode !== 'form' || fields) return;
    let cancelled = false;
    void getFormFields(doc, pageNumber).then((found) => {
      if (!cancelled) onFields(doc, pageNumber, found);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, mode, fields, onFields]);

  const fillable = (fields ?? []).filter(
    (field) => !field.readOnly && !field.name.includes('=') && !/[\r\n]/.test(field.name),
  );
  const interactive = mode !== 'view' && !busy && !panning;

  return (
    <div
      // A selection reports itself in viewport coordinates and knows nothing
      // about pages, so the page has to be findable in the DOM to say which
      // one a highlight landed on.
      data-page-number={pageNumber}
      className="absolute left-1/2 -translate-x-1/2"
      style={{ top, width: size.width * scale, height: size.height * scale }}
    >
      <div
        className={clsx('relative h-full w-full', interactive && 'cursor-crosshair')}
        onClick={(e) => {
          if (!interactive) return;
          const box = e.currentTarget.getBoundingClientRect();
          const at = { x: e.clientX - box.left, y: e.clientY - box.top };
          if (mode === 'text') setTextEditor({ at, value: '', epoch: modeEpoch });
          if (mode === 'stamp') {
            onStamp(pageNumber, at, { width: box.width, height: box.height });
          }
        }}
        onPointerDown={(e) => {
          if (mode !== 'redact' || !interactive) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const box = e.currentTarget.getBoundingClientRect();
          const at = { x: e.clientX - box.left, y: e.clientY - box.top };
          setMarquee({ from: at, to: at });
        }}
        onPointerMove={(e) => {
          if (!marquee) return;
          const box = e.currentTarget.getBoundingClientRect();
          const to = { x: e.clientX - box.left, y: e.clientY - box.top };
          setMarquee((current) => (current ? { ...current, to } : null));
        }}
        onPointerUp={(e) => {
          if (!marquee) return;
          const box = e.currentTarget.getBoundingClientRect();
          onRedact(pageNumber, marquee.from, marquee.to, {
            width: box.width,
            height: box.height,
          });
          setMarquee(null);
        }}
      >
        <canvas
          ref={canvasRef}
          className="block bg-white"
          style={{
            boxShadow: 'var(--pdf-page-shadow)',
            filter: nightMode ? 'invert(90%) hue-rotate(180deg)' : 'none',
          }}
        />

        {/* Selection would fight the marquee and the stamp click, so the text
            layer only takes the pointer while plain reading is going on. */}
        <div
          ref={textLayerRef}
          className={clsx('text-layer', mode !== 'view' && 'pointer-events-none')}
          style={{ '--total-scale-factor': scale } as React.CSSProperties}
        />

        {marquee && (
          <div
            className="pointer-events-none absolute border-2 border-[var(--danger)] bg-[var(--danger)]/30"
            style={{
              left: Math.min(marquee.from.x, marquee.to.x),
              top: Math.min(marquee.from.y, marquee.to.y),
              width: Math.abs(marquee.from.x - marquee.to.x),
              height: Math.abs(marquee.from.y - marquee.to.y),
            }}
          />
        )}

        {(mode === 'draw' || inkAnnotations.length > 0) && (
          <DrawingOverlay
            size={size}
            scale={scale}
            existingInks={inkAnnotations}
            onFinishStroke={(ink) => onAddInkAnnotation?.(pageNumber, ink)}
          />
        )}

        {mode === 'text' && textEditor?.epoch === modeEpoch && (
          <form
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              if (textEditor.value.trim() === '') return;
              onText(
                pageNumber,
                textEditor.value,
                textEditor.at,
                { width: size.width * scale, height: size.height * scale },
              );
              setTextEditor(null);
            }}
            className="absolute z-10 flex h-9 w-[240px] items-center gap-1 rounded-lg border border-[var(--accent)] bg-[var(--surface-panel)] p-1 shadow-xl"
            style={{
              left: Math.max(0, Math.min(textEditor.at.x, size.width * scale - 240)),
              top: Math.max(0, Math.min(textEditor.at.y, size.height * scale - 36)),
            }}
          >
            <input
              autoFocus
              value={textEditor.value}
              placeholder={t('viewerTextPlaceholder', locale)}
              onChange={(event) => setTextEditor({ ...textEditor, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                setTextEditor(null);
              }}
              className="min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-[var(--text-muted)]"
            />
            <button
              type="submit"
              className="h-7 shrink-0 rounded-md bg-[var(--accent)] px-2 text-[11px] font-medium text-white"
            >
              {t('viewerTextAdd', locale)}
            </button>
          </form>
        )}

        {mode === 'form' &&
          fillable.map((field) => (
            <div
              key={field.name}
              className="absolute"
              style={{
                left: `${field.box.x * 100}%`,
                top: `${field.box.y * 100}%`,
                width: `${field.box.width * 100}%`,
                height: `${field.box.height * 100}%`,
              }}
            >
              {field.checkbox ? (
                <input
                  type="checkbox"
                  title={field.name}
                  checked={/^(1|true|yes|on|y)$/i.test(drafts[field.name] ?? '')}
                  onChange={(e) => onDraftChange(field.name, e.target.checked ? 'true' : 'false')}
                  className="h-full w-full accent-[var(--accent)]"
                />
              ) : (
                <input
                  type="text"
                  title={field.name}
                  value={drafts[field.name] ?? ''}
                  onChange={(e) => onDraftChange(field.name, e.target.value)}
                  className="h-full w-full rounded-sm border border-[var(--accent)] bg-[var(--accent-soft)] px-1 text-[12px] text-[var(--text-primary)] outline-none focus:bg-[var(--surface-panel)]"
                />
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
