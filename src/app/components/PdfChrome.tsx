import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { uiRegistry } from '../catalog.ts';
import { t, type Locale } from '../i18n.ts';
import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  FileOutput,
  FilePenLine,
  Hand,
  Loader2,
  Maximize,
  MousePointer2,
  MoveHorizontal,
  PenLine,
  Redo2,
  RotateCw,
  Rows3,
  Save,
  Search,
  Square,
  Stamp,
  Sun,
  Moon,
  Printer,
  ToolIcon,
  Undo2,
  Wrench,
  ZoomIn,
  ZoomOut,
} from '../icons.ts';
import {
  PDF_RIBBON_TABS,
  type PdfRibbonActionItem,
  type PdfRibbonTabId,
  type PdfRibbonViewerAction,
} from '../pdf/pdfRibbonCatalog.ts';

export type PdfViewMode = 'view' | 'text' | 'redact' | 'stamp' | 'form' | 'draw';
export type PdfFitMode = 'width' | 'page' | null;
export type PdfPointerTool = 'hand' | 'select';
export type PdfPageLayout = 'continuous' | 'single';

export interface PdfChromeProps {
  locale: Locale;
  busy: boolean;
  edited: boolean;
  saved: boolean;
  page: number;
  pageCount: number;
  scale: number;
  fit: PdfFitMode;
  mode: PdfViewMode;
  nightMode: boolean;
  pointerTool: PdfPointerTool;
  pageLayout: PdfPageLayout;
  canRedo: boolean;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomActual(): void;
  onFitWidth(): void;
  onFitPage(): void;
  onPrevPage(): void;
  onNextPage(): void;
  onRotatePage(): void;
  onToggleNightMode(): void;
  onPrint(): void;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
  onSaveAs(): void;
  onFind(): void;
  onMode(mode: PdfViewMode): void;
  onPointerTool(tool: PdfPointerTool): void;
  onPageLayout(layout: PdfPageLayout): void;
  onChooseTool(): void;
  onOpenFileMenu(): void;
  /** Opens an existing Magies tool against the current PDF. */
  onRunTool(toolId: string): void;
}

/**
 * WPS-style PDF ribbon: File + category tabs + a single horizontal action row.
 * Tool chips resolve against the live catalogue and call `onRunTool`.
 */
export function PdfChrome(props: PdfChromeProps) {
  const {
    locale,
    busy,
    edited,
    saved,
    page,
    pageCount,
    pointerTool,
    pageLayout,
    mode,
    onOpenFileMenu,
    onRunTool,
  } = props;

  const [tab, setTab] = useState<PdfRibbonTabId>('home');
  const disabled = !pageCount || busy;

  const activeTab = useMemo(() => {
    const found = PDF_RIBBON_TABS.find((entry) => entry.id === tab);
    return found ?? PDF_RIBBON_TABS[0] ?? { id: 'home' as const, labelKey: 'pdfTabHome' as const, items: [] };
  }, [tab]);

  return (
    <div className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)]">
      <div className="flex items-center gap-1 border-b border-[var(--border-subtle)] px-2">
        <button
          type="button"
          onClick={onOpenFileMenu}
          className="shrink-0 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          {t('pdfFileMenu', locale)}
        </button>
        <div role="tablist" className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto pt-0.5">
          {PDF_RIBBON_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={clsx(
                'shrink-0 border-b-2 px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                tab === item.id
                  ? 'border-[var(--accent)] text-[var(--accent)]'
                  : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {t(item.labelKey, locale)}
            </button>
          ))}
        </div>
        {busy && <Loader2 size={14} className="shrink-0 animate-spin text-[var(--text-muted)]" />}
        {edited && (
          <span
            className={clsx(
              'shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
              saved
                ? 'bg-[var(--success-soft)] text-[var(--success)]'
                : 'bg-[var(--accent-soft)] text-[var(--accent)]',
            )}
          >
            {t(saved ? 'viewerSaved' : 'viewerEdited', locale)}
          </span>
        )}
        {pageCount > 0 && (
          <span className="shrink-0 px-1 font-mono text-[11px] text-[var(--text-muted)]">
            {page} / {pageCount}
          </span>
        )}
      </div>

      <div className="flex items-center gap-0.5 overflow-x-auto px-2 py-1.5">
        {activeTab.items.map((item, index) => {
          if (item.kind === 'sep') {
            return <Sep key={`sep-${activeTab.id}-${index}`} />;
          }
          if (item.kind === 'tool') {
            const meta = uiRegistry.tryGet(item.toolId);
            if (!meta) return null;
            return (
              <ToolChip
                key={item.toolId}
                label={meta.name[locale]}
                description={meta.description[locale]}
                icon={meta.icon}
                disabled={disabled}
                onClick={() => onRunTool(item.toolId)}
              />
            );
          }
          return (
            <ActionChip
              key={item.action}
              item={item}
              props={props}
              disabled={disabled}
              nightMode={props.nightMode}
              pointerTool={pointerTool}
              pageLayout={pageLayout}
              mode={mode}
            />
          );
        })}
      </div>
    </div>
  );
}

function ActionChip({
  item,
  props,
  disabled,
  pointerTool,
  pageLayout,
  mode,
}: {
  item: PdfRibbonActionItem;
  props: PdfChromeProps;
  disabled: boolean;
  nightMode: boolean;
  pointerTool: PdfPointerTool;
  pageLayout: PdfPageLayout;
  mode: PdfViewMode;
}) {
  const { locale } = props;
  const a = item.action;

  const run = (action: PdfRibbonViewerAction) => {
    switch (action) {
      case 'hand':
        props.onPointerTool('hand');
        break;
      case 'select':
        props.onPointerTool('select');
        break;
      case 'undo':
        props.onUndo();
        break;
      case 'redo':
        props.onRedo();
        break;
      case 'zoomOut':
        props.onZoomOut();
        break;
      case 'zoomIn':
        props.onZoomIn();
        break;
      case 'zoomActual':
        props.onZoomActual();
        break;
      case 'fitWidth':
        props.onFitWidth();
        break;
      case 'fitPage':
        props.onFitPage();
        break;
      case 'prevPage':
        props.onPrevPage();
        break;
      case 'nextPage':
        props.onNextPage();
        break;
      case 'rotatePage':
        props.onRotatePage();
        break;
      case 'layoutSingle':
        props.onPageLayout('single');
        break;
      case 'layoutContinuous':
        props.onPageLayout('continuous');
        break;
      case 'find':
        props.onFind();
        break;
      case 'save':
        props.onSave();
        break;
      case 'saveAs':
        props.onSaveAs();
        break;
      case 'print':
        props.onPrint();
        break;
      case 'nightMode':
        props.onToggleNightMode();
        break;
      case 'modeText':
        props.onMode('text');
        break;
      case 'modeForm':
        props.onMode('form');
        break;
      case 'modeStamp':
        props.onMode('stamp');
        break;
      case 'modeRedact':
        props.onMode('redact');
        break;
      case 'modeDraw':
        props.onMode('draw');
        break;
      case 'chooseTool':
        props.onChooseTool();
        break;
      default:
        break;
    }
  };

  const map: Record<
    PdfRibbonViewerAction,
    { label: string; icon: React.ReactNode; active?: boolean; tone?: 'accent' | 'danger'; off?: boolean }
  > = {
    hand: {
      label: t('pdfHandTool', locale),
      icon: <Hand size={15} />,
      active: pointerTool === 'hand',
    },
    select: {
      label: t('pdfSelectTool', locale),
      icon: <MousePointer2 size={15} />,
      active: pointerTool === 'select',
    },
    undo: { label: t('viewerUndo', locale), icon: <Undo2 size={15} />, off: !props.edited || props.busy },
    redo: { label: t('viewerRedo', locale), icon: <Redo2 size={15} />, off: !props.canRedo || props.busy },
    zoomOut: { label: t('viewerZoomOut', locale), icon: <ZoomOut size={15} /> },
    zoomIn: { label: t('viewerZoomIn', locale), icon: <ZoomIn size={15} /> },
    zoomActual: {
      label: t('viewerActualSize', locale),
      icon: <span className="min-w-[2rem] text-center font-mono text-[11px]">{Math.round(props.scale * 100)}%</span>,
    },
    fitWidth: {
      label: t('viewerFitWidth', locale),
      icon: <MoveHorizontal size={15} />,
      active: props.fit === 'width',
    },
    fitPage: {
      label: t('viewerFitPage', locale),
      icon: <Maximize size={15} />,
      active: props.fit === 'page',
    },
    prevPage: {
      label: t('viewerPrevPage', locale),
      icon: <ChevronLeft size={15} />,
      off: props.page <= 1,
    },
    nextPage: {
      label: t('viewerNextPage', locale),
      icon: <ChevronRight size={15} />,
      off: props.page >= props.pageCount,
    },
    rotatePage: { label: t('viewerRotatePage', locale), icon: <RotateCw size={15} /> },
    layoutSingle: {
      label: t('pdfLayoutSingle', locale),
      icon: <Square size={14} />,
      active: pageLayout === 'single',
    },
    layoutContinuous: {
      label: t('pdfLayoutContinuous', locale),
      icon: <Rows3 size={15} />,
      active: pageLayout === 'continuous',
    },
    find: { label: t('find', locale), icon: <Search size={15} /> },
    save: {
      label: t('viewerSave', locale),
      icon: (
        <>
          <Save size={15} />
          <span className="ml-1 text-[11px]">{t('viewerSave', locale)}</span>
        </>
      ),
    },
    saveAs: { label: t('viewerSaveAs', locale), icon: <FileOutput size={15} /> },
    print: { label: t('pdfFilePrint', locale), icon: <Printer size={15} /> },
    nightMode: { 
      label: t('pdfNightMode', locale), 
      icon: props.nightMode ? <Sun size={15} /> : <Moon size={15} />,
      active: props.nightMode 
    },
    modeText: {
      label: t('viewerTextMode', locale),
      icon: (
        <>
          <PenLine size={15} />
          <span className="ml-1 text-[11px]">{t('viewerTextMode', locale)}</span>
        </>
      ),
      active: mode === 'text',
    },
    modeForm: {
      label: t('viewerFormMode', locale),
      icon: (
        <>
          <FilePenLine size={15} />
          <span className="ml-1 text-[11px]">{t('viewerFormMode', locale)}</span>
        </>
      ),
      active: mode === 'form',
    },
    modeStamp: {
      label: t('viewerStampMode', locale),
      icon: (
        <>
          <Stamp size={15} />
          <span className="ml-1 text-[11px]">{t('viewerStampMode', locale)}</span>
        </>
      ),
      active: mode === 'stamp',
    },
    modeRedact: {
      label: t('viewerRedactMode', locale),
      icon: (
        <>
          <Eraser size={15} />
          <span className="ml-1 text-[11px]">{t('viewerRedactMode', locale)}</span>
        </>
      ),
      active: mode === 'redact',
      tone: 'danger',
    },
    modeDraw: {
      label: locale === 'zh' ? '自由画笔' : 'Freehand Draw',
      icon: (
        <>
          <PenLine size={15} />
          <span className="ml-1 text-[11px]">{locale === 'zh' ? '自由画笔' : 'Draw'}</span>
        </>
      ),
      active: mode === 'draw',
    },
    chooseTool: {
      label: t('viewerChooseTool', locale),
      icon: (
        <>
          <Wrench size={15} />
          <span className="ml-1 text-[11px]">{t('viewerChooseTool', locale)}</span>
        </>
      ),
    },
  };

  const cfg = map[a];
  return (
    <ChromeBtn
      label={cfg.label}
      active={cfg.active}
      tone={cfg.tone}
      disabled={disabled || Boolean(cfg.off)}
      onClick={() => run(a)}
    >
      {cfg.icon}
    </ChromeBtn>
  );
}

function ToolChip({
  label,
  description,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  description: string;
  icon: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      title={description}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex max-w-[5.5rem] shrink-0 flex-col items-center gap-0.5 rounded-lg px-1.5 py-1 text-center transition-colors disabled:opacity-30',
        'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <ToolIcon name={icon} size={16} className="text-[var(--accent)]" />
      <span className="line-clamp-2 w-full text-[10px] leading-tight">{label}</span>
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-7 w-px shrink-0 self-center bg-[var(--border-subtle)]" aria-hidden />;
}

function ChromeBtn({
  label,
  active,
  tone = 'accent',
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  tone?: 'accent' | 'danger';
  disabled?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex shrink-0 items-center rounded-md px-1.5 py-1.5 transition-colors disabled:opacity-30',
        !active && 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        active && tone === 'accent' && 'bg-[var(--accent-soft)] text-[var(--accent)]',
        active && tone === 'danger' && 'bg-[var(--danger-soft)] text-[var(--danger)]',
      )}
    >
      {children}
    </button>
  );
}
