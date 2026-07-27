import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { countChangelogItems, parseChangelog, type ChangelogEntry } from '../changelog.ts';
import { getChangelogRaw } from '../changelogLocales.ts';
import { t } from '../i18n.ts';
import { ChevronDown, ChevronRight, X } from '../icons.ts';
import { useApp } from '../store.ts';
import { Button } from './ui.tsx';

interface ChangelogDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

function VersionCard({
  entry,
  isLatest,
  defaultOpen,
  locale,
}: {
  entry: ChangelogEntry;
  isLatest: boolean;
  defaultOpen: boolean;
  locale: 'zh' | 'en';
}) {
  const [open, setOpen] = useState(defaultOpen);
  const count = countChangelogItems(entry);

  return (
    <article
      className={clsx(
        'rounded-xl border transition-colors',
        isLatest
          ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)]/40'
          : 'border-[var(--border-subtle)] bg-[var(--surface-panel)]',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight">v{entry.version}</h3>
            {isLatest && (
              <span className="rounded-full border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]">
                {t('whatsNewLatest', locale)}
              </span>
            )}
            <span className="text-[11px] text-[var(--text-muted)]">
              {t('whatsNewChangeCount', locale).replace('{count}', String(count))}
            </span>
          </div>
          {entry.date ? (
            <p className="mt-1 text-xs text-[var(--text-muted)]">{entry.date}</p>
          ) : null}
          {!open && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.sections
                .filter((s) => s.title)
                .slice(0, 4)
                .map((s) => (
                  <span
                    key={s.title}
                    className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]"
                  >
                    {s.title}
                    {s.items.length > 0 ? ` · ${s.items.length}` : ''}
                  </span>
                ))}
            </div>
          )}
        </div>
        <span className="mt-1 shrink-0 text-[var(--text-muted)]">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-[var(--border-subtle)] px-4 pb-4 pt-3">
          {entry.sections.map((section, idx) => (
            <section key={`${section.title}-${idx}`} className="space-y-2">
              {section.title ? (
                <h4 className="text-[12px] font-semibold text-[var(--text-secondary)]">
                  {section.title}
                </h4>
              ) : null}
              <ul className="space-y-1.5">
                {section.items.map((item, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-[12.5px] leading-relaxed text-[var(--text-primary)]"
                  >
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]" />
                    <span className="min-w-0">{item.replace(/\*\*(.+?)\*\*/g, '$1')}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * In-app release notes viewer (MagiesTerminal ChangelogDialog pattern).
 * Fed by the bundled root CHANGELOG.md — no browser jump to GitHub.
 */
export function ChangelogDialog({ open, onOpenChange }: ChangelogDialogProps) {
  const locale = useApp((s) => s.locale);
  // Re-parse when the UI language changes so section titles and bullets switch.
  const entries = useMemo(
    () => parseChangelog(getChangelogRaw(locale)),
    [locale],
  );
  const totalChanges = useMemo(
    () => entries.reduce((n, e) => n + countChangelogItems(e), 0),
    [entries],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="changelog-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        aria-label={t('close', locale)}
        onClick={() => onOpenChange(false)}
      />
      <div className="relative flex max-h-[min(88vh,720px)] w-[min(100vw-2rem,40rem)] flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-app)] shadow-xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
          <div className="min-w-0">
            <h2 id="changelog-title" className="text-base font-semibold tracking-tight">
              {t('whatsNew', locale)}
            </h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {entries.length > 0
                ? t('whatsNewSummary', locale)
                    .replace('{versions}', String(entries.length))
                    .replace('{changes}', String(totalChanges))
                : t('whatsNewSubtitle', locale)}
            </p>
            {entries[0] && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px]">
                  v{entries[0].version}
                </span>
                {entries[0].date ? (
                  <span className="text-[11px] text-[var(--text-muted)]">{entries[0].date}</span>
                ) : null}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 px-2"
            onClick={() => onOpenChange(false)}
            aria-label={t('close', locale)}
          >
            <X size={16} />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {entries.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-[var(--text-muted)]">
              {t('whatsNewEmpty', locale)}
            </p>
          ) : (
            entries.map((entry, index) => (
              <VersionCard
                key={entry.version}
                entry={entry}
                isLatest={index === 0}
                defaultOpen={index === 0}
                locale={locale}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
