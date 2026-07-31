import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES } from '@core/registry.ts';
import type { CategoryId, ToolMeta } from '@core/types.ts';
import {
  bridge,
  hasBridge,
  type OfficeCreateKind,
  type OfficeStatus,
} from '../bridge.ts';
import { uiRegistry } from '../catalog.ts';
import { t } from '../i18n.ts';
import { AlertCircle, Check, FolderOpen, Loader2, Search, Settings, ToolIcon } from '../icons.ts';
import { canUseOnlineOffice } from '../office.ts';
import { useApp } from '../store.ts';

interface HomeProps {
  onOpenTool(toolId: string): void;
  onOpenSearch(): void;
  onOpenCategory(categoryId: CategoryId): void;
  onOpenDocument(): Promise<void>;
  onCreateOffice(kind: OfficeCreateKind): Promise<void>;
}

const CREATE_ACTIONS: Array<{
  kind: OfficeCreateKind;
  labelKey: 'newWord' | 'newSheet' | 'newSlides';
  hintKey: 'newWordHint' | 'newSheetHint' | 'newSlidesHint';
  icon: string;
  tone: string;
}> = [
  {
    kind: 'word',
    labelKey: 'newWord',
    hintKey: 'newWordHint',
    icon: 'FileText',
    tone: 'bg-blue-500/12 text-blue-600 dark:text-blue-400',
  },
  {
    kind: 'sheet',
    labelKey: 'newSheet',
    hintKey: 'newSheetHint',
    icon: 'Table',
    tone: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  },
  {
    kind: 'slide',
    labelKey: 'newSlides',
    hintKey: 'newSlidesHint',
    icon: 'GalleryVertical',
    tone: 'bg-orange-500/12 text-orange-600 dark:text-orange-400',
  },
];

/** WPS-style start centre: create and open come first; specialist tools stay nearby. */
export function Home({
  onOpenTool,
  onOpenSearch,
  onOpenCategory,
  onOpenDocument,
  onCreateOffice,
}: HomeProps) {
  const locale = useApp((state) => state.locale);
  const recentToolIds = useApp((state) => state.recentToolIds);
  const [office, setOffice] = useState<OfficeStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    void bridge()
      .getOfficeStatus()
      .then((status) => {
        if (!cancelled) setOffice(status);
      })
      .catch(() => {
        if (!cancelled) setOffice(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-6 lg:px-9 lg:py-8">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="h-12 w-12 shrink-0 overflow-hidden" aria-hidden="true">
              <img
                src={`${import.meta.env.BASE_URL}logo.png`}
                alt=""
                width={88}
                height={88}
                className="h-[88px] w-[88px] max-w-none -translate-x-5 -translate-y-2 select-none"
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
            className="flex w-full max-w-[280px] items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3 py-2 text-left transition-colors hover:border-[var(--accent)]"
          >
            <Search size={15} className="text-[var(--text-muted)]" />
            <span className="flex-1 text-[12px] text-[var(--text-muted)]">{t('search', locale)}</span>
            <kbd className="rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
              ⌘K
            </kbd>
          </button>
        </header>

        <div className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-[15px] font-semibold">{t('newDocument', locale)}</h2>
                <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{t('newDocumentHint', locale)}</p>
              </div>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              {CREATE_ACTIONS.map((action) => (
                <button
                  key={action.kind}
                  type="button"
                  disabled={busy !== ''}
                  onClick={() => void run(action.kind, () => onCreateOffice(action.kind))}
                  className="group surface-panel min-h-[118px] p-3.5 text-left transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-[var(--accent)] hover:shadow-[var(--shadow-card)] disabled:pointer-events-none disabled:opacity-60"
                >
                  <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${action.tone}`}>
                    {busy === action.kind ? <Loader2 size={18} className="animate-spin" /> : <ToolIcon name={action.icon} size={18} />}
                  </span>
                  <span className="mt-3 block text-[13px] font-medium">{t(action.labelKey, locale)}</span>
                  <span className="mt-1 block text-[10.5px] leading-snug text-[var(--text-muted)]">
                    {t(action.hintKey, locale)}
                  </span>
                </button>
              ))}

              <button
                type="button"
                disabled={busy !== ''}
                onClick={() => onOpenTool('edit.create-blank')}
                className="group surface-panel min-h-[118px] p-3.5 text-left transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-[var(--accent)] hover:shadow-[var(--shadow-card)] disabled:pointer-events-none disabled:opacity-60"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/12 text-red-600 dark:text-red-400">
                  <ToolIcon name="FilePenLine" size={18} />
                </span>
                <span className="mt-3 block text-[13px] font-medium">{t('newPdf', locale)}</span>
                <span className="mt-1 block text-[10.5px] leading-snug text-[var(--text-muted)]">
                  {t('newPdfHint', locale)}
                </span>
              </button>
            </div>

            <button
              type="button"
              disabled={busy !== ''}
              onClick={() => void run('open', onOpenDocument)}
              className="mt-3 flex w-full items-center gap-3 rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-3 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:pointer-events-none disabled:opacity-60"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-sunken)] text-[var(--accent)]">
                {busy === 'open' ? <Loader2 size={18} className="animate-spin" /> : <FolderOpen size={18} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{t('openDocument', locale)}</span>
                <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-muted)]">
                  {t('openDocumentHint', locale)}
                </span>
              </span>
            </button>

            {error && (
              <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11px] text-[var(--danger)]">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}
          </section>

          <aside className="surface-panel h-fit p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[12px] font-semibold">{t('officeEngines', locale)}</h2>
              <Settings size={13} className="text-[var(--text-muted)]" />
            </div>
            <div className="mt-3 space-y-2.5">
              <EngineState
                ready={office?.libreOffice.available === true}
                label="LibreOffice"
                detail={
                  office?.libreOffice.available
                    ? t('libreOfficeReady', locale)
                    : t('libreOfficeMissing', locale)
                }
              />
              <EngineState
                ready={office !== null && canUseOnlineOffice(office)}
                label="Collabora Online"
                detail={
                  office !== null && canUseOnlineOffice(office)
                    ? t('collaboraConfigured', locale)
                    : t('collaboraNotConfigured', locale)
                }
              />
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              {t('officeEngineHint', locale)}
            </p>
          </aside>
        </div>

        {recent.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-2.5 text-[12px] font-semibold">{t('recentTools', locale)}</h2>
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
          <div className="mb-2.5 flex items-baseline justify-between">
            <h2 className="text-[12px] font-semibold">{t('pdfToolbox', locale)}</h2>
            <span className="text-[10px] text-[var(--text-muted)]">{t('pdfToolboxHint', locale)}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map(({ category, count }) => (
              <button
                key={category.id}
                type="button"
                onClick={() => onOpenCategory(category.id)}
                className="surface-panel flex items-start gap-3 p-3 text-left transition-colors hover:border-[var(--accent)]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
                  <ToolIcon name={category.icon} size={15} className="text-[var(--accent)]" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[12px] font-medium">{category.name[locale]}</span>
                    <span className="font-mono text-[9px] text-[var(--text-muted)]">{count}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-[var(--text-secondary)]">
                    {category.description[locale]}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function EngineState({ ready, label, detail }: { ready: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={
          ready
            ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--success-soft)] text-[var(--success)]'
            : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[var(--text-muted)]'
        }
      >
        {ready ? <Check size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-medium">{label}</span>
        <span className="mt-0.5 block text-[9.5px] leading-snug text-[var(--text-muted)]">{detail}</span>
      </span>
    </div>
  );
}
