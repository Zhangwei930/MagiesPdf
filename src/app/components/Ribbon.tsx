import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { CATEGORIES } from '@core/registry.ts';
import type { CategoryId, ToolMeta } from '@core/types.ts';
import { uiRegistry } from '../catalog.ts';
import { t } from '../i18n.ts';
import { Search, ToolIcon } from '../icons.ts';
import { useApp } from '../store.ts';

interface RibbonProps {
  onSelectTool(toolId: string): void;
  onOpenSearch(): void;
  /** True while a document is on screen, which changes what a tool means. */
  onDocument: boolean;
}

/** The recently-used pseudo-tab, which only exists once something has been run. */
const RECENT = 'recent';

/**
 * The command bar: categories across the top, that category's tools underneath.
 *
 * This replaced a 268px tree down the left-hand side. A tree costs a permanent
 * quarter of the window's width and still hides every tool behind a disclosure
 * triangle; a document is wide, and the horizontal space is worth more to it
 * than to a list of folders. Grouping by category along the top is also simply
 * what the applications people already use look like.
 */
export function Ribbon({ onSelectTool, onOpenSearch, onDocument }: RibbonProps) {
  const locale = useApp((s) => s.locale);
  const recentToolIds = useApp((s) => s.recentToolIds);

  const recent = useMemo(
    () =>
      recentToolIds
        .map((id) => uiRegistry.tryGet(id))
        .filter((tool): tool is ToolMeta => Boolean(tool)),
    [recentToolIds],
  );

  const tabs = useMemo(() => {
    const categories = CATEGORIES.map((category) => ({
      key: category.id as CategoryId | typeof RECENT,
      label: category.name[locale],
      icon: category.icon,
      tools: uiRegistry.byCategory(category.id),
    })).filter((tab) => tab.tools.length > 0);

    if (recent.length === 0) return categories;
    return [
      { key: RECENT as CategoryId | typeof RECENT, label: t('recent', locale), icon: 'Workflow', tools: recent },
      ...categories,
    ];
  }, [locale, recent]);

  const [selected, setSelected] = useState<CategoryId | typeof RECENT | null>(null);
  // Defaulting rather than storing means the recent tab takes over as soon as
  // there is one, without an effect to keep the selection legal.
  const active = tabs.find((tab) => tab.key === selected) ?? tabs[0];

  if (!active) return null;

  return (
    <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)]">
      <div className="flex items-center gap-1 px-2 pt-1">
        <div role="tablist" aria-label={t('allTools', locale)} className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={tab.key === active.key}
              onClick={() => setSelected(tab.key)}
              className={clsx(
                'flex shrink-0 items-center gap-1.5 rounded-t-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                tab.key === active.key
                  ? 'bg-[var(--surface-sunken)] text-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <ToolIcon name={tab.icon} size={14} />
              {tab.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onOpenSearch}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[12px] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
        >
          <Search size={13} />
          {t('search', locale)}
          <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1 font-mono text-[10px]">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* The tool row scrolls rather than wrapping: a ribbon that changes height
          as you switch categories moves the document underneath it. */}
      <div className="flex gap-0.5 overflow-x-auto bg-[var(--surface-sunken)] px-2 py-1.5">
        {active.tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            onClick={() => onSelectTool(tool.id)}
            title={`${tool.description[locale]}${onDocument ? `\n${t('ribbonAppliesToDocument', locale)}` : ''}`}
            className="flex w-[76px] shrink-0 flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-center transition-colors hover:bg-[var(--surface-hover)]"
          >
            <ToolIcon name={tool.icon} size={17} className="text-[var(--accent)]" />
            <span className="line-clamp-2 text-[11px] leading-tight text-[var(--text-secondary)]">
              {tool.name[locale]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
