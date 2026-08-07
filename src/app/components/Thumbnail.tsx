import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { RotateCw, Trash2 } from '../icons.ts';
import { t, type Locale } from '../i18n.ts';
import type { Size } from '../pdf/geometry.ts';
import { renderPageToCanvas, type PdfDocumentHandle } from '../pdf/renderer.ts';

/** Thumbnails are laid out to a fixed width, so their scale follows the page. */
const THUMB_WIDTH = 88;
/** Beyond 2× the extra pixels cost memory without being visible. */
const MAX_DPR = 2;

function devicePixels(): number {
  return Math.min(MAX_DPR, window.devicePixelRatio || 1);
}

export function Thumbnail({
  doc,
  pageNumber,
  size,
  epoch,
  active,
  disabled,
  dragging,
  locale,
  onClick,
  onRotate,
  onDelete,
  onDragStart,
  onDragEnd,
  onDropOn,
}: {
  doc: PdfDocumentHandle;
  pageNumber: number;
  size: Size;
  epoch: number;
  active: boolean;
  disabled: boolean;
  dragging: boolean;
  locale: Locale;
  onClick(): void;
  onRotate(): void;
  onDelete(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDropOn(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Large PDFs would otherwise render every page's thumbnail up front;
    // only render once the row is about to scroll into view.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible(true);
      },
      { root: el.closest('aside'), rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Every thumbnail is laid out to the same width, whatever the page's shape.
  const scale = size.width > 0 ? THUMB_WIDTH / size.width : 0.18;

  const drawn = useRef({ epoch: -1, scale: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    // A strip of a hundred thumbnails would otherwise redraw on every rotate.
    if (drawn.current.epoch === epoch && drawn.current.scale === scale) return;

    let stale = false;
    void renderPageToCanvas(doc, pageNumber, canvas, scale, devicePixels(), () => stale)
      .then(() => {
        if (!stale) drawn.current = { epoch, scale };
      })
      .catch(() => {
        // Same as the main page: keep whatever was already drawn.
      });
    return () => {
      stale = true;
    };
  }, [visible, doc, epoch, pageNumber, scale]);

  return (
    <div
      ref={wrapRef}
      draggable={!disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropOn();
      }}
      className={clsx('group relative', dragging && 'opacity-40')}
    >
      <button
        type="button"
        onClick={onClick}
        className={clsx(
          'block w-full overflow-hidden rounded border-2 transition-colors',
          active
            ? 'border-[var(--accent)]'
            : 'border-transparent hover:border-[var(--border-strong)]',
        )}
      >
        <canvas ref={canvasRef} className="mx-auto block bg-white" />
        <span className="block bg-[var(--surface-panel)] py-0.5 text-center font-mono text-[10px] text-[var(--text-muted)]">
          {pageNumber}
        </span>
      </button>

      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label={t('viewerRotatePage', locale)}
          title={t('viewerRotatePage', locale)}
          disabled={disabled}
          onClick={onRotate}
          className="rounded bg-[var(--surface-panel)] p-1 text-[var(--text-secondary)] shadow transition-colors hover:text-[var(--accent)] disabled:opacity-30"
        >
          <RotateCw size={11} />
        </button>
        <button
          type="button"
          aria-label={t('viewerDeletePage', locale)}
          title={t('viewerDeletePage', locale)}
          disabled={disabled}
          onClick={onDelete}
          className="rounded bg-[var(--surface-panel)] p-1 text-[var(--text-secondary)] shadow transition-colors hover:text-[var(--danger)] disabled:opacity-30"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
