import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { uiRegistry } from '../catalog.ts';
import { t } from '../i18n.ts';
import { Search, ToolIcon } from '../icons.ts';
import { useApp } from '../store.ts';

interface CommandPaletteProps {
  onClose(): void;
  onSelect(toolId: string): void;
  /** When set, only tools that accept this file extension are shown (e.g. from the Viewer's "Choose a tool"). */
  filterAccept?: string;
}

/**
 * Rendered only while open, so query and cursor reset naturally on mount rather
 * than through an effect that would fire an extra render on every open.
 */
export function CommandPalette({ onClose, onSelect, filterAccept }: CommandPaletteProps) {
  const locale = useApp((s) => s.locale);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const found = uiRegistry.search(query, locale, 20);
    return filterAccept
      ? found.filter((tool) => tool.input.accept.includes(filterAccept))
      : found;
  }, [query, locale, filterAccept]);

  useEffect(() => {
    // Autofocus has to wait for the input to actually be in the DOM.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // Keep the highlighted row inside the scroll viewport when navigating by keyboard.
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const commit = (index: number) => {
    const tool = results[index];
    if (tool) onSelect(tool.id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay-scrim)] px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-panel)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('search', locale)}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4">
          <Search size={16} className="shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A new query means a new result list; keep the highlight on its first row.
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                commit(cursor);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={t('search', locale)}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {results.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
            {t('noResults', locale)}
          </p>
        ) : (
          <ul ref={listRef} className="max-h-80 overflow-y-auto py-1.5">
            {results.map((tool, index) => (
              <li key={tool.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => commit(index)}
                    className={clsx(
                      'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                      index === cursor ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--surface-hover)]',
                    )}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-sunken)]">
                      <ToolIcon name={tool.icon} size={14} className="text-[var(--accent)]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{tool.name[locale]}</span>
                      <span className="block truncate text-[11px] text-[var(--text-muted)]">
                        {tool.description[locale]}
                      </span>
                    </span>
                  </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
