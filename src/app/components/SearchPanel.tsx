import { ChevronLeft, ChevronRight, Search, X } from '../icons.ts';
import { t, type Locale } from '../i18n.ts';
import { ToolbarButton } from './ViewerWidgets.tsx';

export interface SearchPanelProps {
  locale: Locale;
  query: string;
  matchCount: number;
  matchIndex: number;
  searching: boolean;
  onQueryChange(query: string): void;
  onSearch(query: string): void;
  onStep(direction: 1 | -1): void;
  onClose(): void;
}

/**
 * The ⌘F search bar that sits above the page column.
 * Extracted from Viewer so the find state machine is not tangled with zoom/scroll.
 */
export function SearchPanel({
  locale,
  query,
  matchCount,
  matchIndex,
  searching,
  onQueryChange,
  onSearch,
  onStep,
  onClose,
}: SearchPanelProps) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (matchCount === 0) onSearch(query);
        else onStep(1);
      }}
      className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-2"
    >
      <Search size={14} className="shrink-0 text-[var(--text-muted)]" />
      <input
        autoFocus
        value={query}
        placeholder={t('findPlaceholder', locale)}
        aria-label={t('findPlaceholder', locale)}
        onChange={(event) => {
          onQueryChange(event.target.value);
        }}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-muted)]"
      />
      <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
        {searching
          ? t('findSearching', locale)
          : matchCount === 0
            ? query.trim() === ''
              ? ''
              : t('findNone', locale)
            : `${matchIndex + 1}/${matchCount}`}
      </span>
      <ToolbarButton
        label={t('findPrevious', locale)}
        disabled={matchCount === 0}
        onClick={() => onStep(-1)}
      >
        <ChevronLeft size={14} />
      </ToolbarButton>
      <ToolbarButton
        label={t('findNext', locale)}
        disabled={matchCount === 0}
        onClick={() => onStep(1)}
      >
        <ChevronRight size={14} />
      </ToolbarButton>
      <ToolbarButton label={t('close', locale)} onClick={onClose}>
        <X size={14} />
      </ToolbarButton>
    </form>
  );
}
