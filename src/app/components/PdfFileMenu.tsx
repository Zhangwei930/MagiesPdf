import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { bridge, hasBridge, type RecentDocument } from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import {
  FileOutput,
  FilePenLine,
  FolderOpen,
  Loader2,
  Minimize2,
  Printer,
  Save,
  Settings,
  X,
} from '../icons.ts';

export interface PdfFileMenuProps {
  locale: Locale;
  open: boolean;
  onClose(): void;
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
  onPrint(): void;
  onSettings(): void;
  onRunTool(toolId: string): void;
  onOpenRecent(path: string): void;
}

type ExportItem = {
  toolId: string;
  labelKey:
    | 'pdfToWord'
    | 'pdfToExcel'
    | 'pdfToPpt'
    | 'pdfExportImage'
    | 'pdfExportText'
    | 'pdfExportHtml'
    | 'pdfExportMarkdown'
    | 'pdfExportCsv';
};

const EXPORTS: ExportItem[] = [
  { toolId: 'convert.pdf-to-docx', labelKey: 'pdfToWord' },
  { toolId: 'convert.pdf-to-xlsx', labelKey: 'pdfToExcel' },
  { toolId: 'convert.pdf-to-pptx', labelKey: 'pdfToPpt' },
  { toolId: 'convert.pdf-to-image', labelKey: 'pdfExportImage' },
  { toolId: 'convert.pdf-to-text', labelKey: 'pdfExportText' },
  { toolId: 'convert.pdf-to-html', labelKey: 'pdfExportHtml' },
  { toolId: 'convert.pdf-to-markdown', labelKey: 'pdfExportMarkdown' },
  { toolId: 'convert.pdf-to-csv', labelKey: 'pdfExportCsv' },
];

function formatWhen(openedAt: number, locale: Locale): string {
  const d = new Date(openedAt);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) {
    const prefix = locale === 'zh' ? '今天' : 'Today';
    return `${prefix} ${d.toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`;
  }
  return d.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * WPS-style File menu for PDF: left command list + right recent list.
 * Overlay sits above the canvas; the document stays visible behind the dimmer.
 */
export function PdfFileMenu({
  locale,
  open,
  onClose,
  onOpen,
  onSave,
  onSaveAs,
  onPrint,
  onSettings,
  onRunTool,
  onOpenRecent,
}: PdfFileMenuProps) {
  const [recent, setRecent] = useState<RecentDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!hasBridge()) return;
    setLoading(true);
    try {
      const list = await bridge().listRecentDocuments();
      setRecent(list.filter((item) => item.kind === 'pdf' || item.name.toLowerCase().endsWith('.pdf')));
    } catch {
      setRecent([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load recent when the menu opens — async setState after await is fine.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void (async () => {
      if (!hasBridge()) return;
      try {
        const list = await bridge().listRecentDocuments();
        if (cancelled) return;
        setRecent(list.filter((item) => item.kind === 'pdf' || item.name.toLowerCase().endsWith('.pdf')));
      } catch {
        if (!cancelled) setRecent([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const close = useCallback(() => {
    setExportOpen(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const run = (action: () => void) => {
    action();
    close();
  };

  return (
    <div className="absolute inset-0 z-30 flex" role="dialog" aria-label={t('pdfFileMenu', locale)}>
      <button
        type="button"
        aria-label={t('cancel', locale)}
        className="absolute inset-0 bg-black/35"
        onClick={close}
      />
      <div className="relative z-10 m-2 flex max-h-[min(72vh,520px)] w-[min(100%-1rem,520px)] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-2xl">
        {/* Left: commands */}
        <nav className="flex w-[11.5rem] shrink-0 flex-col gap-0.5 border-r border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2">
          <MenuBtn
            icon={<FolderOpen size={15} />}
            label={t('pdfFileOpen', locale)}
            onClick={() => run(onOpen)}
          />
          <MenuBtn
            icon={<Save size={15} />}
            label={t('viewerSave', locale)}
            onClick={() => run(onSave)}
          />
          <MenuBtn
            icon={<FileOutput size={15} />}
            label={t('viewerSaveAs', locale)}
            onClick={() => run(onSaveAs)}
          />
          <div className="relative">
            <MenuBtn
              icon={<FilePenLine size={15} />}
              label={t('pdfFileExportAs', locale)}
              trailing
              active={exportOpen}
              onClick={() => setExportOpen((v) => !v)}
            />
            {exportOpen && (
              <div className="absolute left-full top-0 z-20 ml-1 min-w-[9.5rem] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-1 shadow-xl">
                {EXPORTS.map((item) => (
                  <button
                    key={item.toolId}
                    type="button"
                    className="flex w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                    onClick={() => run(() => onRunTool(item.toolId))}
                  >
                    {t(item.labelKey, locale)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <MenuBtn
            icon={<Minimize2 size={15} />}
            label={t('pdfFileCompress', locale)}
            onClick={() => run(() => onRunTool('edit.compress'))}
          />
          <MenuBtn
            icon={<Printer size={15} />}
            label={t('pdfFilePrint', locale)}
            onClick={() => run(onPrint)}
          />
          <div className="my-1 h-px bg-[var(--border-subtle)]" />
          <MenuBtn
            icon={<Settings size={15} />}
            label={t('settings', locale)}
            onClick={() => run(onSettings)}
          />
        </nav>

        {/* Right: recent PDFs */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
            <span className="text-[12px] font-medium text-[var(--text-secondary)]">
              {t('pdfFileRecent', locale)}
            </span>
            {loading && <Loader2 size={13} className="animate-spin text-[var(--text-muted)]" />}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {recent.length === 0 && !loading && (
              <p className="px-2 py-6 text-center text-[12px] text-[var(--text-muted)]">
                {t('pdfFileRecentEmpty', locale)}
              </p>
            )}
            {recent.map((doc) => (
              <div
                key={doc.path}
                className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-hover)]"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => run(() => onOpenRecent(doc.path))}
                  title={doc.path}
                >
                  <div className="truncate text-[12.5px] text-[var(--text-primary)]">{doc.name}</div>
                  <div className="truncate text-[11px] text-[var(--text-muted)]">
                    {doc.path}
                  </div>
                </button>
                <span className="shrink-0 pt-0.5 text-[10px] text-[var(--text-muted)]">
                  {formatWhen(doc.openedAt, locale)}
                </span>
                <button
                  type="button"
                  aria-label={t('removeFromRecent', locale)}
                  className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 hover:text-[var(--danger)] group-hover:opacity-100"
                  onClick={async (event) => {
                    event.stopPropagation();
                    await bridge().forgetRecentDocument(doc.path);
                    await refresh();
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuBtn({
  icon,
  label,
  onClick,
  trailing,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick(): void;
  trailing?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors',
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <span className="shrink-0 text-[var(--accent)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing && <span className="text-[10px] text-[var(--text-muted)]">›</span>}
    </button>
  );
}
