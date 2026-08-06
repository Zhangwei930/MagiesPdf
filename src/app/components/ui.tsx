import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { clsx } from 'clsx';
import { Loader2 } from '../icons.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:hover:bg-[var(--accent)]',
  secondary:
    'bg-[var(--surface-raised)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
  danger: 'bg-[var(--danger)] text-white hover:opacity-90',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-6 text-[15px] gap-2',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** React 19 hands function components a ref like any other prop. */
  ref?: Ref<HTMLButtonElement>;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap',
        'transition-colors duration-150 select-none',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'danger' | 'accent' }) {
  const tones = {
    neutral: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
    success: 'bg-[var(--success-soft)] text-[var(--success)]',
    danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  };
  return (
    <span className={clsx('inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function Field({
  label,
  help,
  children,
  htmlFor,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[14px] font-medium text-[var(--text-primary)]">
        {label}
      </label>
      {children}
      {help && <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">{help}</p>}
    </div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]"
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ease-out"
        style={{ width: `${Math.max(2, value * 100)}%` }}
      />
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint }: { icon: typeof Loader2; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <Icon size={26} className="text-[var(--text-muted)]" strokeWidth={1.5} />
      <p className="text-sm font-medium text-[var(--text-secondary)]">{title}</p>
      {hint && <p className="max-w-sm text-xs text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}
