import { useMemo, useState } from 'react';
import { CATEGORIES } from '@core/registry.ts';
import type { CategoryId, ToolMeta } from '@core/types.ts';
import { uiRegistry } from '../catalog.ts';
import { t } from '../i18n.ts';
import { AlertCircle, Eye, Search, ToolIcon } from '../icons.ts';
import { useApp } from '../store.ts';

interface HomeProps {
  onOpenTool(toolId: string): void;
  onOpenSearch(): void;
  onOpenCategory(categoryId: CategoryId): void;
  onOpenPreview(): Promise<void>;
}

/**
 * Welcome / overview panel shown in the main column when no tool is selected.
 * Tool navigation lives in the sidebar; this surface is orientation + shortcuts.
 */
export function Home({ onOpenTool, onOpenSearch, onOpenCategory, onOpenPreview }: HomeProps) {
  const locale = useApp((s) => s.locale);
  const recentToolIds = useApp((s) => s.recentToolIds);
  const [previewError, setPreviewError] = useState('');

  const recent = useMemo(
    () =>
      recentToolIds
        .map((id) => uiRegistry.tryGet(id))
        .filter((tool): tool is ToolMeta => Boolean(tool))
        .slice(0, 6),
    [recentToolIds],
  );

  const categories = useMemo(
    () =>
      CATEGORIES.map((category) => ({
        category,
        count: uiRegistry.byCategory(category.id).length,
      })).filter(({ count }) => count > 0),
    [],
  );

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-8 py-10">
      <section className="text-center">
        <img
          src={`${import.meta.env.BASE_URL}logo.png`}
          alt="MagiesPDF"
          width={96}
          height={96}
          className="mx-auto h-24 w-24 select-none object-contain drop-shadow-[0_0_24px_rgba(59,130,246,0.35)]"
          draggable={false}
        />
        <h1 className="mt-3 text-[26px] font-semibold tracking-tight">MagiesPdf</h1>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-[var(--text-secondary)]">
          {t('tagline', locale)}
        </p>
        <p className="mx-auto mt-2 max-w-sm text-[12px] text-[var(--text-muted)]">
          {t('sidebarHint', locale)}
        </p>

        <button
          type="button"
          onClick={onOpenSearch}
          className="mx-auto mt-5 flex w-full max-w-md items-center gap-2.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-2.5 text-left transition-colors hover:border-[var(--accent)]"
        >
          <Search size={16} className="shrink-0 text-[var(--text-muted)]" />
          <span className="flex-1 text-sm text-[var(--text-muted)]">{t('search', locale)}</span>
          <kbd className="shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            ⌘K
          </kbd>
        </button>

        <button
          type="button"
          onClick={() => {
            setPreviewError('');
            onOpenPreview().catch((cause) => {
              setPreviewError(cause instanceof Error ? cause.message : String(cause));
            });
          }}
          className="mx-auto mt-2.5 flex w-full max-w-md items-center gap-2.5 rounded-xl border border-dashed border-[var(--border-subtle)] px-4 py-2.5 text-left transition-colors hover:border-[var(--accent)]"
        >
          <Eye size={16} className="shrink-0 text-[var(--text-muted)]" />
          <span className="flex-1 text-sm text-[var(--text-muted)]">{t('openPreview', locale)}</span>
        </button>
        {previewError && (
          <p className="mx-auto mt-2 flex max-w-md items-center gap-1.5 text-xs text-[var(--danger)]">
            <AlertCircle size={12} />
            {previewError}
          </p>
        )}
      </section>

      {recent.length > 0 && (
        <section className="mt-9">
          <h2 className="mb-2.5 text-[12px] font-semibold tracking-wide text-[var(--text-muted)] uppercase">
            {t('recent', locale)}
          </h2>
          <div className="flex flex-wrap gap-2">
            {recent.map((tool) => (
              <button
                key={tool.id}
                type="button"
                onClick={() => onOpenTool(tool.id)}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 py-1.5 text-[12px] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                <ToolIcon name={tool.icon} size={14} className="text-[var(--accent)]" />
                {tool.name[locale]}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-2.5 text-[12px] font-semibold tracking-wide text-[var(--text-muted)] uppercase">
          {t('allTools', locale)}
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {categories.map(({ category, count }) => (
            <button
              key={category.id}
              type="button"
              onClick={() => onOpenCategory(category.id)}
              className="surface-panel flex items-start gap-3 p-3.5 text-left transition-colors hover:border-[var(--accent)]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
                <ToolIcon name={category.icon} size={17} className="text-[var(--accent)]" />
              </span>
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium">{category.name[locale]}</span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">{count}</span>
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-secondary)]">
                  {category.description[locale]}
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
