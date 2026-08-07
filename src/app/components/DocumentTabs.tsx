import { clsx } from 'clsx';
import { isDirty, type DocumentState } from '../documents.ts';
import { t } from '../i18n.ts';
import { FileText, X } from '../icons.ts';
import { useApp } from '../store.ts';

interface DocumentTabsProps {
  documents: readonly DocumentState[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  /**
   * `titlebar` — WPS-style pills in the app title bar.
   * `strip` — standalone row under the ribbon (legacy).
   */
  variant?: 'titlebar' | 'strip';
}

/**
 * The open documents, as tabs. Nothing shows until there is a document, so the
 * app does not carry an empty strip around for people who only ever run a tool.
 */
export function DocumentTabs({
  documents,
  activeId,
  onSelect,
  onClose,
  variant = 'strip',
}: DocumentTabsProps) {
  const locale = useApp((s) => s.locale);
  if (documents.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label={t('tabsLabel', locale)}
      className={clsx(
        'flex min-w-0 items-center gap-1 overflow-x-auto',
        variant === 'strip' &&
          'shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2 py-1',
        variant === 'titlebar' && 'px-1',
      )}
    >
      {documents.map((document) => {
        const active = document.id === activeId;
        const dirty = isDirty(document);

        return (
          <div
            key={document.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(document.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(document.id);
              }
            }}
            // The middle button closes a tab, the way it does in a browser.
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(document.id);
            }}
            title={document.path || document.name}
            className={clsx(
              'group flex max-w-[200px] min-w-0 cursor-pointer items-center gap-1.5 text-[12px] transition-colors',
              variant === 'titlebar' && 'rounded-md px-2.5 py-1',
              variant === 'strip' && 'rounded-full px-3 py-1',
              active
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            <FileText
              size={13}
              className={clsx('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')}
            />
            <span className="min-w-0 flex-1 truncate">{document.name}</span>

            {/* The dot is the tab's unsaved marker; hovering swaps it for the
                close button, so the two never fight over the same spot. */}
            {dirty && (
              <span
                aria-label={t('tabUnsaved', locale)}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)] group-hover:hidden"
              />
            )}
            <button
              type="button"
              aria-label={t('tabClose', locale)}
              onClick={(event) => {
                event.stopPropagation();
                onClose(document.id);
              }}
              className={clsx(
                'shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--danger)]',
                dirty ? 'hidden group-hover:block' : 'opacity-0 group-hover:opacity-100',
              )}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
