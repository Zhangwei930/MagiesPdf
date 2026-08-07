import { clsx } from 'clsx';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../pdf/highlights.ts';
import { t, type Locale } from '../i18n.ts';
import { PenLine } from '../icons.ts';

export function HighlightToolbar({
  locale,
  activeColor,
  onChangeColor,
}: {
  locale: Locale;
  activeColor: HighlightColor | null;
  onChangeColor(color: HighlightColor | null): void;
}) {
  const colors = Object.entries(HIGHLIGHT_COLORS) as [HighlightColor, string][];

  return (
    <div className="flex items-center gap-2 rounded-md bg-[var(--surface-panel)] px-2 py-1 shadow-md border border-[var(--border-subtle)]">
      <div className="flex items-center gap-1">
        {colors.map(([name, hex]) => (
          <button
            key={name}
            type="button"
            title={`${locale === 'zh' ? '文本高亮' : 'Highlight'} - ${name}`}
            onClick={() => onChangeColor(activeColor === name ? null : name)}
            className={clsx(
              'h-6 w-6 rounded-full border-2 transition-transform',
              activeColor === name ? 'border-[var(--text-primary)] scale-110' : 'border-transparent hover:scale-105'
            )}
            style={{ backgroundColor: hex }}
          />
        ))}
      </div>
      <div className="w-[1px] h-4 bg-[var(--border-subtle)] mx-1" />
      <button
        type="button"
        title={t('viewerDrawMode', locale)}
        className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      >
        <PenLine size={14} />
      </button>
    </div>
  );
}
