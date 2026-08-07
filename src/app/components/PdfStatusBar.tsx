import { clsx } from 'clsx';
import { formatBytes, t, type Locale } from '../i18n.ts';
import { ChevronLeft, ChevronRight, Minus, Plus, Rows3, Square } from '../icons.ts';
import type { PdfPageLayout } from './PdfChrome.tsx';

export interface PdfStatusBarProps {
  locale: Locale;
  page: number;
  pageCount: number;
  scale: number;
  pageLayout: PdfPageLayout;
  /** Current document size in memory (updates after compress / edits). */
  byteLength?: number;
  disabled?: boolean;
  onPrevPage(): void;
  onNextPage(): void;
  onGoToPage(page: number): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomTo(scale: number): void;
  onPageLayout(layout: PdfPageLayout): void;
}

/**
 * WPS-style bottom strip: page jump + zoom slider, always available under the
 * document so the top chrome can stay short.
 */
export function PdfStatusBar({
  locale,
  page,
  pageCount,
  scale,
  pageLayout,
  byteLength,
  disabled,
  onPrevPage,
  onNextPage,
  onGoToPage,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onPageLayout,
}: PdfStatusBarProps) {
  if (pageCount <= 0) return null;

  const percent = Math.round(scale * 100);

  return (
    <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 text-[11px] text-[var(--text-secondary)]">
      <button
        type="button"
        aria-label={t('viewerPrevPage', locale)}
        disabled={disabled || page <= 1}
        onClick={onPrevPage}
        className="rounded p-0.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
      >
        <ChevronLeft size={14} />
      </button>
      <input
        type="number"
        min={1}
        max={pageCount}
        value={page}
        aria-label={t('viewerGoToPage', locale)}
        disabled={disabled}
        onChange={(e) => {
          const target = Number(e.target.value);
          if (Number.isFinite(target)) onGoToPage(target);
        }}
        className="w-10 rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1 py-0.5 text-center font-mono outline-none focus:border-[var(--accent)] disabled:opacity-30"
      />
      <span className="font-mono text-[var(--text-muted)]">/ {pageCount}</span>
      <button
        type="button"
        aria-label={t('viewerNextPage', locale)}
        disabled={disabled || page >= pageCount}
        onClick={onNextPage}
        className="rounded p-0.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
      >
        <ChevronRight size={14} />
      </button>

      <div className="mx-1 flex items-center gap-0.5 rounded-md border border-[var(--border-subtle)] p-0.5">
        <button
          type="button"
          title={t('pdfLayoutSingle', locale)}
          aria-pressed={pageLayout === 'single'}
          disabled={disabled}
          onClick={() => onPageLayout('single')}
          className={clsx(
            'rounded p-0.5 disabled:opacity-30',
            pageLayout === 'single'
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'hover:bg-[var(--surface-hover)]',
          )}
        >
          <Square size={13} />
        </button>
        <button
          type="button"
          title={t('pdfLayoutContinuous', locale)}
          aria-pressed={pageLayout === 'continuous'}
          disabled={disabled}
          onClick={() => onPageLayout('continuous')}
          className={clsx(
            'rounded p-0.5 disabled:opacity-30',
            pageLayout === 'continuous'
              ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
              : 'hover:bg-[var(--surface-hover)]',
          )}
        >
          <Rows3 size={13} />
        </button>
      </div>

      <div className="flex-1" />

      {typeof byteLength === 'number' && byteLength >= 0 && (
        <span className="shrink-0 font-mono text-[var(--text-muted)]" title={t('pdfFileSize', locale)}>
          {t('pdfFileSize', locale)} {formatBytes(byteLength, locale)}
        </span>
      )}

      <span className="text-[var(--text-muted)]">{t('pdfLocalFile', locale)}</span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={t('viewerZoomOut', locale)}
          disabled={disabled}
          onClick={onZoomOut}
          className="rounded p-0.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
        >
          <Minus size={13} />
        </button>
        <input
          type="range"
          min={25}
          max={400}
          step={5}
          value={percent}
          disabled={disabled}
          aria-label={t('viewerActualSize', locale)}
          onChange={(e) => onZoomTo(Number(e.target.value) / 100)}
          className={clsx(
            'h-1 w-24 cursor-pointer accent-[var(--accent)] disabled:opacity-30',
          )}
        />
        <button
          type="button"
          aria-label={t('viewerZoomIn', locale)}
          disabled={disabled}
          onClick={onZoomIn}
          className="rounded p-0.5 hover:bg-[var(--surface-hover)] disabled:opacity-30"
        >
          <Plus size={13} />
        </button>
        <span className="min-w-[2.5rem] text-right font-mono">{percent}%</span>
      </div>
    </footer>
  );
}
