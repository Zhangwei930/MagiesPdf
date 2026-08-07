import { useEffect, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { t, type Locale } from '../i18n.ts';
import { ToolIcon, X } from '../icons.ts';

export type ToolWindowSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<ToolWindowSize, string> = {
  /** Most single tools — compact WPS dialog. */
  sm: 'max-w-[min(100vw-2rem,26rem)]',
  /** Sign / multi-section tools. */
  md: 'max-w-[min(100vw-2rem,36rem)]',
  /** Batch / pipeline builders. */
  lg: 'max-w-[min(100vw-2rem,48rem)]',
};

interface ToolWindowProps {
  title: string;
  subtitle?: string;
  icon?: string;
  locale: Locale;
  busy?: boolean;
  size?: ToolWindowSize;
  onClose(): void;
  footer: ReactNode;
  children: ReactNode;
}

/**
 * Shared chrome for feature dialogs: centered window, dimmed backdrop,
 * compact header, fixed footer with 确定 / 取消 — closer to WPS than a full page.
 */
export function ToolWindow({
  title,
  subtitle,
  icon,
  locale,
  busy = false,
  size = 'sm',
  onClose,
  footer,
  children,
}: ToolWindowProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-6" role="presentation">
      <button
        type="button"
        aria-label={t('cancel', locale)}
        className="absolute inset-0 bg-black/30"
        disabled={busy}
        onClick={() => {
          if (!busy) onClose();
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'relative z-10 flex w-full flex-col overflow-hidden',
          size === 'lg' ? 'max-h-[min(94vh,52rem)]' : 'max-h-[min(92vh,42rem)]',
          'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-2xl',
          SIZE_CLASS[size],
        )}
      >
        <header className="flex shrink-0 items-center gap-2.5 border-b border-[var(--border-subtle)] px-3.5 py-2.5">
          {icon && (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
              <ToolIcon name={icon} size={16} className="text-[var(--accent)]" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-semibold leading-tight">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--text-muted)]">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
            aria-label={t('close', locale)}
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">{children}</div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-3.5 py-2.5">
          {footer}
        </footer>
      </div>
    </div>
  );
}
