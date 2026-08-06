import { clsx } from 'clsx';

/**
 * A small button used in the PDF Chrome toolbar and the find bar.
 * Supports an active-pressed state with colour tones.
 */
export function ToolbarButton({
  label,
  active,
  tone = 'accent',
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  /** What being active looks like — redaction destroys content, so it warns. */
  tone?: 'accent' | 'danger';
  disabled?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'shrink-0 rounded-md p-1.5 transition-colors disabled:opacity-30',
        !active &&
          'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        active && tone === 'accent' && 'bg-[var(--accent-soft)] text-[var(--accent)]',
        active && tone === 'danger' && 'bg-[var(--danger-soft)] text-[var(--danger)]',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Coloured strip banner shown below the toolbar when an editing mode is
 * active, or when there is a notice to display (decrypted, error, etc.).
 */
export function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'danger' | 'accent' | 'muted';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        'flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs',
        tone === 'danger' && 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]',
        tone === 'accent' && 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]',
        tone === 'muted' &&
          'border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
      )}
    >
      {icon}
      {children}
    </div>
  );
}
