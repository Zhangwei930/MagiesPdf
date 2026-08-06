import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Check, Copy, type LucideIcon } from '../icons.ts';
import { Button } from './ui.tsx';

/**
 * Shared chrome for the AI surfaces, adapted from MagiesTerminal.
 *
 * The panel and the settings pane are the same product; they read as one
 * because both draw their cards, rows, toggles and status marks from here
 * rather than each inventing a border and a padding of its own.
 */

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TONE_PLATE: Record<Tone, string> = {
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
  accent: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  success: 'bg-[var(--success-soft)] text-[var(--success)]',
  warning: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
};

const PLATE_SIZES = {
  sm: 'h-6 w-6 rounded-lg text-[9px]',
  md: 'h-8 w-8 rounded-xl text-[11px]',
  lg: 'h-10 w-10 rounded-xl text-[13px]',
} as const;

/** A tinted square behind an icon or a two-letter mark. */
export function IconPlate({
  icon: Icon,
  mark,
  tone = 'neutral',
  size = 'md',
  className,
}: {
  icon?: LucideIcon;
  mark?: string;
  tone?: Tone;
  size?: keyof typeof PLATE_SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={clsx('ai-plate font-semibold', PLATE_SIZES[size], TONE_PLATE[tone], className)}
    >
      {Icon ? <Icon size={size === 'lg' ? 18 : size === 'md' ? 15 : 12} /> : mark}
    </span>
  );
}

/** Status mark: a dot plus a word, in the tone that matches the state. */
export function StatusPill({
  tone = 'neutral',
  pulse = false,
  children,
}: {
  tone?: Tone;
  pulse?: boolean;
  children: ReactNode;
}) {
  const dot = {
    neutral: 'bg-[var(--text-muted)]',
    accent: 'bg-[var(--accent)]',
    success: 'bg-[var(--success)]',
    warning: 'bg-[var(--warning)]',
    danger: 'bg-[var(--danger)]',
  }[tone];
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium',
        TONE_PLATE[tone],
      )}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', dot, pulse && 'animate-pulse')} />
      {children}
    </span>
  );
}

/** Segmented control used for the sub-sections of a settings pane. */
export function SubTabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: Array<{ id: T; label: string; icon?: LucideIcon }>;
  onChange(id: T): void;
}) {
  return (
    <div
      role="tablist"
      className="grid gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-1"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map(({ id, label, icon: Icon }) => {
        const active = id === value;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={clsx(
              'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-[13.5px] font-medium transition-colors',
              active
                ? 'bg-[var(--surface-panel)] text-[var(--text-primary)] shadow-[var(--shadow-card)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {Icon && <Icon size={13} />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** A titled group. `actions` sits on the title row, right-aligned. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-7 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-semibold tracking-tight">{title}</h3>
          {description && (
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function SettingCard({
  children,
  divided = false,
  className,
}: {
  children: ReactNode;
  /** Row list with hairlines between; spacing comes from SettingRow. */
  divided?: boolean;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-[var(--shadow-card)]',
        divided ? 'divide-y divide-[var(--border-subtle)] px-3.5' : 'p-3.5',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Label and description on the left, the control on the right. */
export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        {description && (
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {description}
          </div>
        )}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent',
        'transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--surface-sunken)] ring-1 ring-[var(--border-strong)]',
      )}
    >
      <span
        className={clsx(
          'pointer-events-none block h-5 w-5 rounded-full bg-[var(--surface-panel)] shadow-md transition-transform duration-200 ease-out',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/** A read-only snippet with the copy button the surrounding card would grow. */
export function CopyableCode({
  label,
  value,
  copyLabel,
  copiedLabel,
  copied,
  onCopy,
}: {
  label?: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
  copied: boolean;
  onCopy(): void;
}) {
  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={onCopy}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? copiedLabel : copyLabel}
          </Button>
        </div>
      )}
      <pre className="max-h-52 overflow-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-[var(--text-secondary)]">
        {value}
      </pre>
    </div>
  );
}

/** The rounded-square spinner the chat panel shows while a turn is running. */
export function AiSpinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-3.5 w-3.5 rounded-[4px]' : 'h-4 w-4 rounded-[5px]';
  return (
    <span aria-hidden className={clsx('ai-square-spinner', box)}>
      <span className="ai-square-spinner__ring" />
      <span className="ai-square-spinner__core" />
    </span>
  );
}

/** Spinner plus a shimmering label — the "working" state, framed or bare. */
export function ActivityIndicator({
  label,
  framed = true,
  trailing,
}: {
  label: string;
  framed?: boolean;
  trailing?: ReactNode;
}) {
  const body = (
    <>
      <AiSpinner size={framed ? 'md' : 'sm'} />
      <span className="thinking-shimmer min-w-0 truncate text-[12.5px] font-medium tracking-wide">
        {label}
      </span>
      {trailing}
    </>
  );
  if (!framed) {
    return (
      <div role="status" aria-live="polite" className="inline-flex items-center gap-2">
        {body}
      </div>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative flex w-fit max-w-full items-center gap-2.5 overflow-hidden rounded-full border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-1.5"
    >
      <span className="ai-sheen pointer-events-none absolute inset-0" aria-hidden />
      <span className="relative z-[1] flex min-w-0 items-center gap-2.5">{body}</span>
    </div>
  );
}
