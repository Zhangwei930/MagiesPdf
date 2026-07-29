import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { CategoryId, ToolMeta } from '@core/types.ts';
import { uiRegistry } from './catalog.ts';
import { bridge, hasBridge, type PickedFile } from './bridge.ts';
import { t } from './i18n.ts';
import { AlertCircle, Eye, Loader2, Settings } from './icons.ts';
import { currentPlatform, isTypingTarget, matchShortcut } from './shortcuts.ts';
import { activeJobCount, useApp } from './store.ts';
import { isDirty, type DocumentState } from './documents.ts';
import { canApplyToDocument } from './toolApply.ts';
import { CommandPalette } from './components/CommandPalette.tsx';
import { ApplyToolPanel } from './components/ApplyToolPanel.tsx';
import { DocumentTabs } from './components/DocumentTabs.tsx';
import { Home } from './components/Home.tsx';
import { JobPanel } from './components/JobPanel.tsx';
import { Ribbon } from './components/Ribbon.tsx';
import { ToolPage } from './components/ToolPage.tsx';
import { UpdatePrompt } from './components/UpdatePrompt.tsx';
import { Badge, Button } from './components/ui.tsx';

/**
 * Screens that most sessions never open, kept out of the entry chunk.
 *
 * The Viewer is here because pdfjs-dist is ~1 MB on its own. The rest are here
 * because they are big and conditional: a pipeline builder, a batch runner, a
 * signature pad and the settings panel are each a page someone visits
 * occasionally, and none of them should be parsed before the window paints.
 */
const Viewer = lazy(() =>
  import('./components/Viewer.tsx').then((module) => ({ default: module.Viewer })),
);
const BatchPage = lazy(() =>
  import('./components/BatchPage.tsx').then((module) => ({ default: module.BatchPage })),
);
const PipelinePage = lazy(() =>
  import('./components/PipelinePage.tsx').then((module) => ({ default: module.PipelinePage })),
);
const SettingsPanel = lazy(() =>
  import('./components/SettingsPanel.tsx').then((module) => ({ default: module.SettingsPanel })),
);
const SignPage = lazy(() =>
  import('./components/SignPage.tsx').then((module) => ({ default: module.SignPage })),
);

/** Shown while one of the screens above is being fetched. */
function ScreenFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 size={22} className="animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

type MainView =
  | { name: 'welcome' }
  | { name: 'tool'; toolId: string; initialFile?: PickedFile }
  | { name: 'document' }
  | { name: 'settings' };

export function App() {
  const ready = useApp((s) => s.ready);
  const locale = useApp((s) => s.locale);
  const jobs = useApp((s) => s.jobs);
  const startupError = useApp((s) => s.startupError);
  const initialize = useApp((s) => s.initialize);
  const documents = useApp((s) => s.documents);
  const activeDocumentId = useApp((s) => s.activeDocumentId);
  const openDocument = useApp((s) => s.openDocument);
  const closeDocument = useApp((s) => s.closeDocument);
  const setActiveDocument = useApp((s) => s.setActiveDocument);
  const saveDocument = useApp((s) => s.saveDocument);

  const [main, setMain] = useState<MainView>({ name: 'welcome' });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Set while the palette was opened from the document toolbar, so the results
  // are scoped to tools that accept a PDF.
  const [paletteForDocument, setPaletteForDocument] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  // A tab being closed with unsaved changes, held until the user decides.
  const [closing, setClosing] = useState<DocumentState | null>(null);
  // The tool being run against the open document, if any.
  const [applying, setApplying] = useState<ToolMeta | null>(null);
  // Nested dragenter/dragleave pairs fire per child element; counting them is
  // the only reliable way to know the pointer has truly left the window.
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState('');

  const activeDocument = documents.find((d) => d.id === activeDocumentId) ?? null;

  useEffect(() => {
    void initialize();
  }, [initialize]);

  /**
   * Where picking a tool goes.
   *
   * With a document in hand there are two cases. A tool that wants one PDF runs
   * against it right there, with the result landing back in the page — the
   * document is never found, saved and re-opened just to be worked on. A tool
   * that needs more than that still needs its full page, but opens with the
   * document already loaded rather than an empty drop zone.
   *
   * `withActiveDocument` is what makes the sidebar behave like a ribbon while a
   * document is on screen, and like plain navigation when one is not.
   */
  const routeToTool = useCallback(
    (toolId: string, withActiveDocument: boolean) => {
      const picked = uiRegistry.tryGet(toolId);

      if (withActiveDocument && activeDocument && picked) {
        if (canApplyToDocument(picked)) {
          setApplying(picked);
          return;
        }
        setMain({
          name: 'tool',
          toolId,
          initialFile: {
            name: activeDocument.name,
            path: activeDocument.path,
            size: activeDocument.bytes.length,
            mime: 'application/pdf',
            bytes: activeDocument.bytes,
          },
        });
        return;
      }
      setMain({ name: 'tool', toolId });
    },
    [activeDocument],
  );

  const openTool = useCallback(
    (toolId: string) => {
      setPaletteOpen(false);
      routeToTool(toolId, main.name === 'document');
    },
    [main.name, routeToTool],
  );

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteForDocument(false);
  }, []);

  const openWelcome = useCallback(() => setMain({ name: 'welcome' }), []);
  const openSettings = useCallback(() => setMain({ name: 'settings' }), []);

  /** Opens a file as a document and shows it. */
  const showDocument = useCallback(
    (file: PickedFile) => {
      openDocument(file);
      setMain({ name: 'document' });
    },
    [openDocument],
  );

  const openViewerPicker = useCallback(async () => {
    const [file] = await bridge().pickFiles(['.pdf'], false);
    if (file) showDocument(file);
  }, [showDocument]);

  /** Reads paths and opens each as its own tab. */
  const openPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      for (const file of await bridge().readFiles(paths)) showDocument(file);
    },
    [showDocument],
  );

  const selectTab = useCallback(
    (id: string) => {
      setActiveDocument(id);
      setMain({ name: 'document' });
    },
    [setActiveDocument],
  );

  /** Closing a tab with unsaved changes asks first; a clean one just goes. */
  const requestCloseTab = useCallback(
    (id: string) => {
      const document = documents.find((d) => d.id === id);
      if (document && isDirty(document)) {
        setClosing(document);
        return;
      }
      closeDocument(id);
    },
    [closeDocument, documents],
  );

  /**
   * The view actually shown. Closing the last tab leaves `main` pointing at a
   * document that is gone; deriving the fallback here means the pane can never
   * render empty, where an effect would correct it a render too late.
   */
  const view: MainView = main.name === 'document' && !activeDocument ? { name: 'welcome' } : main;

  // Double-click in Finder / Explorer, Open With, a drop on the dock icon, or a
  // second launch: the main process forwards them all here.
  useEffect(() => {
    if (!hasBridge()) return;
    return bridge().onOpenFiles((paths) => {
      void openPaths(paths).catch((cause) => {
        setDropError(cause instanceof Error ? cause.message : String(cause));
      });
    });
  }, [openPaths]);

  const openToolPickerForDocument = useCallback(() => {
    setPaletteForDocument(true);
    setPaletteOpen(true);
  }, []);

  const onPaletteSelect = useCallback(
    (toolId: string) => {
      const forDocument = paletteForDocument;
      closePalette();
      routeToTool(toolId, forDocument);
    },
    [closePalette, paletteForDocument, routeToTool],
  );

  /**
   * The shell's shortcuts. Document shortcuts (save, zoom, paging) belong to
   * the Viewer and are handled there; the two sets are disjoint.
   */
  useEffect(() => {
    const platform = currentPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      const action = matchShortcut(event, platform, { typing: isTypingTarget(event.target) });

      switch (action) {
        case 'open':
          void openViewerPicker().catch(() => {
            // The picker only fails if the bridge is gone, which the banner says.
          });
          break;
        case 'palette':
          // ⌘K always means "search everything" — drop any document scoping.
          setPaletteForDocument(false);
          setPaletteOpen((open) => !open);
          break;
        case 'dismiss':
          closePalette();
          setJobsOpen(false);
          setDropError('');
          break;
        case 'close':
          // ⌘W closes the open document, then falls back to leaving whatever
          // page you are on. With nothing open it means the window, which is
          // Electron's to handle — so it is deliberately not prevented.
          if (view.name === 'document' && activeDocumentId) requestCloseTab(activeDocumentId);
          else if (view.name !== 'welcome') openWelcome();
          else return;
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDocumentId, closePalette, view.name, openViewerPicker, openWelcome, requestCloseTab]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={22} className="animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (startupError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md space-y-3 rounded-[var(--radius-card)] border border-[var(--danger)] bg-[var(--danger-soft)] p-5">
          <div className="flex items-center gap-2 text-[var(--danger)]">
            <AlertCircle size={16} />
            <h1 className="text-sm font-semibold">{t('startupFailed', locale)}</h1>
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {t('startupFailedHint', locale)}
          </p>
          <p className="font-mono text-[11px] break-all text-[var(--text-muted)]">{startupError}</p>
        </div>
      </div>
    );
  }

  const running = activeJobCount(jobs);
  const tool = view.name === 'tool' ? uiRegistry.tryGet(view.toolId) : undefined;
  const showRibbon = view.name !== 'settings';

  return (
    <div
      className="flex h-full flex-col"
      // A file dropped anywhere in the window opens, the way it does in an
      // office suite. Tool drop zones stop the event before it reaches here.
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        setDropError('');
        // The renderer only ever sees paths; the main process does the reading.
        const paths = Array.from(e.dataTransfer.files)
          .map((dropped) => bridge().pathForFile(dropped))
          .filter((path) => path.toLowerCase().endsWith('.pdf'));
        if (paths.length === 0) {
          setDropError(t('dropNotPdf', locale));
          return;
        }
        void openPaths(paths).catch((cause) => {
          setDropError(cause instanceof Error ? cause.message : String(cause));
        });
      }}
    >
      <header className="drag-region flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3">
        <div className="w-[68px] shrink-0" />

        <button
          type="button"
          onClick={openWelcome}
          className="no-drag rounded-md px-2 py-1 text-[13px] font-semibold tracking-tight transition-colors hover:bg-[var(--surface-hover)]"
        >
          MagiesPdf
        </button>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => setJobsOpen(true)}
          className="no-drag flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          {t('jobs', locale)}
          {running > 0 && <Badge tone="accent">{running}</Badge>}
        </button>

        <button
          type="button"
          onClick={openSettings}
          aria-label={t('settings', locale)}
          className="no-drag rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <Settings size={15} />
        </button>
      </header>

      {!hasBridge() && (
        <div className="flex items-center gap-2 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-2 text-xs text-[var(--danger)]">
          <AlertCircle size={13} className="shrink-0" />
          {t('bridgeMissing', locale)}
        </div>
      )}

      {showRibbon && (
        <Ribbon
          onSelectTool={openTool}
          onOpenSearch={() => setPaletteOpen(true)}
          onDocument={view.name === 'document'}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 w-0 min-w-0 flex-1 flex-col">
          <DocumentTabs
            documents={documents}
            activeId={view.name === 'document' ? activeDocumentId : null}
            onSelect={selectTab}
            onClose={requestCloseTab}
          />

          <main
            className={clsx(
              'min-h-0 flex-1 bg-[var(--surface-app)]',
              view.name === 'settings' || view.name === 'document'
                ? 'overflow-hidden'
                : 'overflow-y-auto',
            )}
          >
            {/* One boundary for every lazily-loaded screen below. */}
            <Suspense fallback={<ScreenFallback />}>
            {view.name === 'settings' && <SettingsPanel onBack={openWelcome} />}

            {view.name === 'document' && activeDocument && (
              /* Keyed by document id so switching tabs remounts the viewer's
                 own view state — scroll, zoom, mode — per document, while the
                 bytes and history stay in the store. */
              <Viewer
                key={activeDocument.id}
                document={activeDocument}
                onChooseTool={openToolPickerForDocument}
              />
            )}

            {view.name === 'tool' &&
              (tool ? (
                tool.id === 'advanced.pipeline' ? (
                  <PipelinePage key={tool.id} tool={tool} onBack={openWelcome} />
                ) : tool.id === 'advanced.batch' ? (
                  <BatchPage key={tool.id} tool={tool} onBack={openWelcome} />
                ) : tool.id === 'security.add-signature' ? (
                  <SignPage key={tool.id} tool={tool} onBack={openWelcome} />
                ) : (
                  <ToolPage
                    key={tool.id}
                    tool={tool}
                    onBack={openWelcome}
                    initialFile={view.initialFile}
                    onPreviewFile={showDocument}
                  />
                )
              ) : (
                <Home
                  onOpenTool={openTool}
                  onOpenSearch={() => setPaletteOpen(true)}
                  onOpenCategory={(_categoryId: CategoryId) => openWelcome()}
                  onOpenPreview={openViewerPicker}
                />
              ))}

            {view.name === 'welcome' && (
              <Home
                onOpenTool={openTool}
                onOpenSearch={() => setPaletteOpen(true)}
                onOpenCategory={(_categoryId: CategoryId) => {
                  // Categories live in the ribbon; keep welcome and let the user pick there.
                  openWelcome();
                }}
                onOpenPreview={openViewerPicker}
              />
            )}
            </Suspense>
          </main>
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          onSelect={onPaletteSelect}
          filterAccept={paletteForDocument ? '.pdf' : undefined}
        />
      )}
      {applying && activeDocument && (
        <ApplyToolPanel
          key={`${applying.id}|${activeDocument.id}`}
          tool={applying}
          document={activeDocument}
          onClose={() => setApplying(null)}
        />
      )}
      <JobPanel open={jobsOpen} onClose={() => setJobsOpen(false)} />
      <UpdatePrompt />

      {dropping && (
        <div
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[var(--accent-soft)]/85 backdrop-blur-sm"
          role="presentation"
        >
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-[var(--accent)] px-10 py-8">
            <Eye size={26} className="text-[var(--accent)]" />
            <p className="text-sm font-medium text-[var(--accent)]">{t('dropToOpen', locale)}</p>
          </div>
        </div>
      )}

      {dropError && (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)] shadow-lg">
          <AlertCircle size={13} className="shrink-0" />
          <span className="max-w-md truncate">{dropError}</span>
          <button
            type="button"
            aria-label={t('close', locale)}
            onClick={() => setDropError('')}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {closing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
          role="presentation"
        >
          <div
            className="w-full max-w-sm space-y-4 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-panel)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={t('closeDirtyTitle', locale)}
          >
            <div>
              <h2 className="text-sm font-semibold">{t('closeDirtyTitle', locale)}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                {t('closeDirtyHint', locale).replace('{name}', closing.name)}
              </p>
            </div>
            {/* Save / Don't save / Cancel, in that order — the same three
                choices, and the same wording, an office suite offers. */}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                {t('cancel', locale)}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  closeDocument(closing.id);
                  setClosing(null);
                }}
              >
                {t('closeDirtyDiscard', locale)}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const target = closing.id;
                  setClosing(null);
                  void saveDocument(target)
                    .then(() => closeDocument(target))
                    .catch((cause) => {
                      // A failed save must not take the document with it.
                      setDropError(cause instanceof Error ? cause.message : String(cause));
                    });
                }}
              >
                {t('closeDirtySave', locale)}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
