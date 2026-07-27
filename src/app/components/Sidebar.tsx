import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { CATEGORIES } from '@core/registry.ts';
import type { CategoryId, ToolMeta } from '@core/types.ts';
import { bridge, hasBridge } from '../bridge.ts';
import { uiRegistry } from '../catalog.ts';
import { t } from '../i18n.ts';
import { ChevronDown, ChevronRight, ToolIcon } from '../icons.ts';
import { useApp } from '../store.ts';
import { APP_VERSION } from '../version.ts';

interface SidebarProps {
  activeToolId: string | null;
  onSelectHome(): void;
  onSelectTool(toolId: string): void;
}

type DrawerKey = 'recent' | CategoryId;

/**
 * Drawer sidebar: click a category row to expand/collapse its tools.
 */
export function Sidebar({
  activeToolId,
  onSelectHome,
  onSelectTool,
}: SidebarProps) {
  const locale = useApp((s) => s.locale);
  const recentToolIds = useApp((s) => s.recentToolIds);
  const [version, setVersion] = useState(APP_VERSION);

  useEffect(() => {
    if (!hasBridge()) return;
    void bridge()
      .getVersion()
      .then((v) => {
        if (v) setVersion(v);
      })
      .catch(() => {
        /* keep APP_VERSION fallback */
      });
  }, []);

  /** Folders the user has expanded by clicking. */
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const first = CATEGORIES[0]?.id;
    return new Set(first ? [first] : []);
  });
  /** Folders the user has explicitly collapsed (wins over auto-open). */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const recent = useMemo(
    () =>
      recentToolIds
        .map((id) => uiRegistry.tryGet(id))
        .filter((tool): tool is ToolMeta => Boolean(tool)),
    [recentToolIds],
  );

  const groups = useMemo(() => {
    const categoryGroups = CATEGORIES.map((category) => ({
      key: category.id as DrawerKey,
      icon: category.icon,
      label: category.name[locale],
      tools: uiRegistry.byCategory(category.id),
    })).filter((group) => group.tools.length > 0);

    if (recent.length === 0) return categoryGroups;
    return [
      {
        key: 'recent' as DrawerKey,
        icon: 'Workflow',
        label: t('recent', locale),
        tools: recent,
      },
      ...categoryGroups,
    ];
  }, [locale, recent]);

  const activeTool = activeToolId ? uiRegistry.tryGet(activeToolId) : undefined;

  const isExpanded = (key: string) => {
    // User collapse always wins.
    if (collapsed.has(key)) return false;
    if (expanded.has(key)) return true;
    // Auto-expand the folder that owns the current tool (e.g. opened via ⌘K).
    if (activeTool && key === activeTool.category) return true;
    if (key === 'recent' && activeToolId && recent.some((tool) => tool.id === activeToolId)) {
      return true;
    }
    return false;
  };

  /** Click category header → expand or collapse. */
  const toggleFolder = (key: string) => {
    const currentlyOpen = isExpanded(key);
    if (currentlyOpen) {
      setCollapsed((prev) => new Set(prev).add(key));
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    } else {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setExpanded((prev) => new Set(prev).add(key));
    }
  };

  const openFolder = (key: string) => {
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setExpanded((prev) => new Set(prev).add(key));
  };

  return (
    <aside className="flex h-full w-[268px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-panel)]">
      <div className="no-drag shrink-0 border-b border-[var(--border-subtle)] px-3 py-3">
        <button
          type="button"
          onClick={onSelectHome}
          className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--surface-hover)]"
        >
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 select-none object-contain"
            draggable={false}
          />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold tracking-tight">MagiesPdf</div>
            <div className="truncate text-[10px] text-[var(--text-muted)]">v{version}</div>
          </div>
        </button>
      </div>

      <nav className="no-drag min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ul className="space-y-0.5">
          {groups.map((group) => {
            const open = isExpanded(group.key);
            const hasActive = group.tools.some((tool) => tool.id === activeToolId);

            return (
              <li key={group.key} className="select-none">
                {/* Category row — click expands / collapses the drawer */}
                <button
                  type="button"
                  onClick={() => toggleFolder(group.key)}
                  aria-expanded={open}
                  title={open ? t('collapseFolder', locale) : t('expandFolder', locale)}
                  className={clsx(
                    'flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-[12.5px] transition-colors',
                    hasActive
                      ? 'bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
                      : 'font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]">
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </span>
                  <ToolIcon name={group.icon} size={15} className="shrink-0 opacity-90" />
                  <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">
                    {group.tools.length}
                  </span>
                </button>

                {/* Nested tools — only while expanded */}
                {open ? (
                  <ul className="mt-0.5 mb-1.5 ml-3 space-y-0.5 border-l border-[var(--border-subtle)] pl-2">
                    {group.tools.map((tool) => {
                      const active = activeToolId === tool.id;
                      return (
                        <li key={tool.id}>
                          <button
                            type="button"
                            onClick={() => {
                              openFolder(group.key);
                              onSelectTool(tool.id);
                            }}
                            title={tool.description[locale]}
                            className={clsx(
                              'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                              active
                                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                            )}
                          >
                            <span
                              className={clsx(
                                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                                active
                                  ? 'bg-[var(--accent)] text-white'
                                  : 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
                              )}
                            >
                              <ToolIcon name={tool.icon} size={13} />
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-snug">
                              {tool.name[locale]}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
