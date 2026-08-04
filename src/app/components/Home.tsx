import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bridge,
  hasBridge,
  type OfficeCreateKind,
  type RecentDocument,
} from '../bridge.ts';
import { uiRegistry } from '../catalog.ts';
import { t } from '../i18n.ts';
import {
  AlertCircle,
  Bot,
  Check,
  FilePenLine,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
  ArrowLeftRight,
  ToolIcon,
} from '../icons.ts';
import { useApp } from '../store.ts';
import { Button } from './ui.tsx';

interface HomeProps {
  onOpenTool(toolId: string): void;
  onOpenSearch(): void;
  onOpenDocument(): Promise<void>;
  onCreateOffice(kind: OfficeCreateKind): Promise<void>;
  onCreatePdf(): Promise<void>;
  onOpenRecent(path: string): Promise<void>;
  onOpenAi(): void;
}

const CREATE_ACTIONS: Array<{
  kind: OfficeCreateKind;
  labelKey: 'newWord' | 'newSheet' | 'newSlides';
  hintKey: 'newWordHint' | 'newSheetHint' | 'newSlidesHint';
  icon: string;
  tone: string;
}> = [
  { kind: 'word', labelKey: 'newWord', hintKey: 'newWordHint', icon: 'FileText', tone: 'office-word' },
  { kind: 'sheet', labelKey: 'newSheet', hintKey: 'newSheetHint', icon: 'Table', tone: 'office-sheet' },
  { kind: 'slide', labelKey: 'newSlides', hintKey: 'newSlidesHint', icon: 'GalleryVertical', tone: 'office-slide' },
];

const QUICK_CONVERSIONS = [
  'convert.docx-to-pdf',
  'convert.xlsx-to-pdf',
  'convert.pptx-to-pdf',
  'convert.pdf-to-docx',
  'convert.pdf-to-xlsx',
  'convert.pdf-to-pptx',
];

/**
 * The start centre's left rail.
 *
 * Every entry either performs an action or scrolls to a section that is really
 * on this page — a rail item that leads nowhere is worse than no rail at all,
 * so there are no placeholders here for folders the app cannot browse.
 */
const RAIL = [
  { id: 'recent', labelKey: 'railRecent', icon: Check, action: 'scroll' },
  { id: 'convert', labelKey: 'railConvert', icon: ArrowLeftRight, action: 'scroll' },
  { id: 'ai', labelKey: 'railAi', icon: Bot, action: 'ai' },
] as const;

const DOCUMENT_TONES: Record<RecentDocument['kind'], { icon: string; className: string }> = {
  word: { icon: 'FileText', className: 'office-word' },
  sheet: { icon: 'Table', className: 'office-sheet' },
  slide: { icon: 'GalleryVertical', className: 'office-slide' },
  pdf: { icon: 'FilePenLine', className: 'office-pdf' },
};

/** WPS-style start centre focused on the customer's files, not engine configuration. */
export function Home({
  onOpenTool,
  onOpenSearch,
  onOpenDocument,
  onCreateOffice,
  onCreatePdf,
  onOpenRecent,
  onOpenAi,
}: HomeProps) {
  const locale = useApp((state) => state.locale);
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<RecentDocument | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<RecentDocument | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const createRef = useRef<HTMLDivElement>(null);

  /** A popover over the page has to close the way every other one does. */
  useEffect(() => {
    if (!createOpen) return undefined;
    const dismiss = (event: MouseEvent) => {
      if (!createRef.current?.contains(event.target as Node)) setCreateOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setCreateOpen(false); };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [createOpen]);

  /** Scrolls the content column, not the window — the rail must stay put. */
  const scrollToSection = useCallback((id: string) => {
    const target = scrollRef.current?.querySelector(`[data-home-section="${id}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const loadWorkspace = useCallback(async () => {
    if (!hasBridge()) return;
    setRecentDocuments(await bridge().listRecentDocuments());
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!hasBridge()) return;
    void bridge().listRecentDocuments()
      .then((recent) => {
        if (!cancelled) setRecentDocuments(recent);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleDocuments = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    if (!needle) return recentDocuments;
    return recentDocuments.filter((document) =>
      `${document.name} ${document.path}`.toLocaleLowerCase(locale).includes(needle),
    );
  }, [locale, query, recentDocuments]);

  const conversions = useMemo(
    () => QUICK_CONVERSIONS.map((id) => uiRegistry.tryGet(id)).filter((tool) => tool !== undefined),
    [],
  );



  const run = async (key: string, action: () => Promise<void>, refresh = false) => {
    setBusy(key);
    setError('');
    try {
      await action();
      if (refresh) await loadWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  const startRename = (document: RecentDocument) => {
    const dot = document.name.lastIndexOf('.');
    setRenameValue(dot > 0 ? document.name.slice(0, dot) : document.name);
    setRenaming(document);
  };

  const submitRename = async () => {
    if (!renaming || !renameValue.trim()) return;
    await run(`rename:${renaming.path}`, async () => {
      await bridge().renameRecentDocument(renaming.path, renameValue);
      setRenaming(null);
    }, true);
  };

  const submitDelete = async () => {
    if (!deleting) return;
    await run(`delete:${deleting.path}`, async () => {
      await bridge().trashRecentDocument(deleting.path);
      setDeleting(null);
    }, true);
  };

  const createOffice = async (kind: OfficeCreateKind) => {
    await run(kind, () => onCreateOffice(kind), true);
  };

  const selectRail = (entry: (typeof RAIL)[number]) => {
    if (entry.action === 'ai') onOpenAi();
    else scrollToSection(entry.id);
  };

  return (
    <div className="flex h-full">
      {/* The rail an office suite opens on: what you can make, what you can
          open, and where the things you already have are. Making something is
          one button with the kinds behind it, rather than a grid of cards
          competing with the customer's own files for the middle of the page. */}
      <aside className="hidden w-[188px] shrink-0 flex-col gap-2 border-r border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-4 md:flex">
        <div ref={createRef} className="relative">
          <Button
            variant="primary"
            className="w-full justify-center"
            onClick={() => setCreateOpen((open) => !open)}
            aria-expanded={createOpen}
          >
            <Plus size={15} />
            {t('newDocument', locale)}
          </Button>

          {createOpen && (
            <div className="absolute left-0 top-[calc(100%+6px)] z-30 w-[340px] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow-card)]">
              <p className="px-1 text-[11px] font-medium text-[var(--text-muted)]">{t('newDocumentHint', locale)}</p>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {CREATE_ACTIONS.map((action) => (
                  <button
                    key={action.kind}
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => { setCreateOpen(false); void createOffice(action.kind); }}
                    className="flex flex-col items-center gap-2 rounded-lg px-1 py-3 transition-colors hover:bg-[var(--surface-panel)] disabled:pointer-events-none disabled:opacity-60"
                  >
                    <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${action.tone}`}>
                      {busy === action.kind ? <Loader2 size={20} className="animate-spin" /> : <ToolIcon name={action.icon} size={20} />}
                    </span>
                    <span className="text-[11px] text-[var(--text-secondary)]">{t(action.labelKey, locale)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy !== ''}
                  onClick={() => { setCreateOpen(false); void run('pdf', onCreatePdf); }}
                  className="flex flex-col items-center gap-2 rounded-lg px-1 py-3 transition-colors hover:bg-[var(--surface-panel)] disabled:pointer-events-none disabled:opacity-60"
                >
                  <span className="office-pdf flex h-11 w-11 items-center justify-center rounded-xl">
                    {busy === 'pdf' ? <Loader2 size={20} className="animate-spin" /> : <ToolIcon name="FilePenLine" size={20} />}
                  </span>
                  <span className="text-[11px] text-[var(--text-secondary)]">{t('newPdf', locale)}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <Button
          className="w-full justify-center"
          disabled={busy !== ''}
          onClick={() => void run('open', onOpenDocument, true)}
        >
          {busy === 'open' ? <Loader2 size={15} className="animate-spin" /> : <FolderOpen size={15} />}
          {t('openDocument', locale)}
        </Button>

        <nav className="mt-2 flex flex-col gap-0.5">
          {RAIL.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => selectRail(entry)}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-panel)] hover:text-[var(--text)]"
            >
              <entry.icon size={15} className="shrink-0 text-[var(--text-muted)]" />
              <span className="truncate">{t(entry.labelKey, locale)}</span>
            </button>
          ))}
        </nav>

      </aside>

      <div ref={scrollRef} className="h-full flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-5 py-5 lg:px-8 lg:py-7">
        <header className="flex items-center justify-between gap-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="h-12 w-12 shrink-0" aria-hidden="true">
              <img
                src={`${import.meta.env.BASE_URL}logo.png`}
                alt=""
                width={48}
                height={48}
                className="h-12 w-12 select-none"
                draggable={false}
              />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[22px] font-semibold tracking-tight">{t('appName', locale)}</h1>
              <p className="mt-0.5 truncate text-[12px] text-[var(--text-secondary)]">
                {t('officeTagline', locale)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenSearch}
            className="flex w-full max-w-[300px] items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2 text-left shadow-sm transition-[border-color,box-shadow] hover:border-[var(--accent)] hover:shadow-[var(--shadow-card)]"
          >
            <Search size={15} className="text-[var(--text-muted)]" />
            <span className="flex-1 text-[12px] text-[var(--text-muted)]">{t('search', locale)}</span>
            <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">⌘K</kbd>
          </button>
        </header>

        {error && (
          <p className="mt-4 flex items-start gap-1.5 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {/* The customer's documents in the middle, what can be done to them at
            the side. A start centre that leads with its own features makes
            someone scroll past them to reach the file they came for. */}
        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section data-home-region="documents" data-home-section="recent" className="min-w-0">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <h2 className="text-[14px] font-semibold">{t('recentDocuments', locale)}</h2>
              <label className="flex w-full max-w-[220px] items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-2.5 py-1.5 focus-within:border-[var(--accent)]">
                <Search size={13} className="text-[var(--text-muted)]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('searchRecentDocuments', locale)}
                  className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-[var(--text-muted)]"
                />
                {query && <button type="button" onClick={() => setQuery('')} aria-label={t('clear', locale)}><X size={12} /></button>}
              </label>
            </div>

            <div className="surface-panel overflow-hidden">
              {visibleDocuments.length > 0 ? (
                visibleDocuments.map((document) => {
                  const tone = DOCUMENT_TONES[document.kind];
                  const folder = document.path.slice(0, Math.max(document.path.lastIndexOf('/'), document.path.lastIndexOf('\\')));
                  return (
                    <div key={document.path} className="group flex items-center border-b border-[var(--border-subtle)] px-3 py-2.5 last:border-b-0 hover:bg-[var(--surface-hover)]">
                      <button
                        type="button"
                        disabled={busy !== ''}
                        onClick={() => void run(`open:${document.path}`, () => onOpenRecent(document.path), true)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-60"
                      >
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.className}`}>
                          {busy === `open:${document.path}` ? <Loader2 size={16} className="animate-spin" /> : <ToolIcon name={tone.icon} size={17} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium">{document.name}</span>
                          <span className="mt-0.5 block truncate text-[9.5px] text-[var(--text-muted)]">{folder}</span>
                        </span>
                        <span className="hidden shrink-0 text-[9.5px] text-[var(--text-muted)] sm:block">{formatDate(document.modifiedAt, locale)}</span>
                      </button>

                      <div className="ml-2 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <RowAction label={t('showInFolder', locale)} onClick={() => void bridge().revealPath(document.path)}><FolderOpen size={13} /></RowAction>
                        <RowAction label={t('renameDocument', locale)} onClick={() => startRename(document)}><FilePenLine size={13} /></RowAction>
                        <RowAction label={t('removeFromRecent', locale)} onClick={() => void run(`forget:${document.path}`, async () => { await bridge().forgetRecentDocument(document.path); }, true)}><X size={13} /></RowAction>
                        <RowAction label={t('moveToTrash', locale)} danger onClick={() => setDeleting(document)}><Trash2 size={13} /></RowAction>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="flex min-h-[150px] flex-col items-center justify-center px-4 text-center">
                  <FolderOpen size={24} strokeWidth={1.5} className="text-[var(--text-muted)]" />
                  <p className="mt-2 text-[12px] font-medium text-[var(--text-secondary)]">{query ? t('noRecentSearchResults', locale) : t('recentDocumentsEmpty', locale)}</p>
                  <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">{t('recentDocumentsEmptyHint', locale)}</p>
                </div>
              )}
            </div>
          </section>

          {/* Everything that can be done to a document, beside the documents.
              Conversions first because that is what an Office file is usually
              opened here to become; the toolbox below it, by category. */}
          <aside data-home-region="tools" className="space-y-5">
            <section data-home-section="convert">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-[12px] font-semibold">{t('quickConversions', locale)}</h2>
                <span className="text-[9.5px] text-[var(--text-muted)]">{t('localOnly', locale)}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {conversions.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => onOpenTool(tool.id)}
                    className="surface-panel flex min-h-16 items-center gap-2 p-2.5 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                  >
                    <ToolIcon name={tool.icon} size={15} className="shrink-0 text-[var(--accent)]" />
                    <span className="text-[10.5px] leading-snug">{tool.name[locale]}</span>
                  </button>
                ))}
              </div>
            </section>

          </aside>
        </div>

      </div>
      </div>

      {renaming && (
        <ConfirmDialog title={t('renameDocument', locale)} onClose={() => setRenaming(null)}>
          <input
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitRename();
              if (event.key === 'Escape') setRenaming(null);
            }}
            className="field-input"
          />
          <p className="mt-2 text-[10.5px] text-[var(--text-muted)]">{t('renameKeepsFormat', locale)}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" onClick={() => setRenaming(null)}>{t('cancel', locale)}</Button>
            <Button size="sm" variant="primary" loading={busy.startsWith('rename:')} disabled={!renameValue.trim()} onClick={() => void submitRename()}>{t('renameDocument', locale)}</Button>
          </div>
        </ConfirmDialog>
      )}

      {deleting && (
        <ConfirmDialog title={t('moveToTrash', locale)} onClose={() => setDeleting(null)}>
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">{t('moveToTrashConfirm', locale).replace('{name}', deleting.name)}</p>
          <p className="mt-2 text-[10.5px] text-[var(--text-muted)]">{t('moveToTrashHint', locale)}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" onClick={() => setDeleting(null)}>{t('cancel', locale)}</Button>
            <Button size="sm" variant="danger" loading={busy.startsWith('delete:')} onClick={() => void submitDelete()}>{t('moveToTrash', locale)}</Button>
          </div>
        </ConfirmDialog>
      )}

    </div>
  );
}

function formatDate(value: number, locale: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function RowAction({ label, danger = false, onClick, children }: { label: string; danger?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${danger ? 'text-[var(--text-muted)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]' : 'text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-primary)]'}`}
    >
      {children}
    </button>
  );
}

function ConfirmDialog({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="surface-panel w-full max-w-sm p-4 shadow-2xl" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="mb-3 text-[14px] font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
