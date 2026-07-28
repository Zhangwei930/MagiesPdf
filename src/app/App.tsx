import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import type { CategoryId } from '@core/types.ts';
import { uiRegistry } from './catalog.ts';
import { bridge, hasBridge, type PickedFile } from './bridge.ts';
import { t } from './i18n.ts';
import { AlertCircle, Loader2, Settings } from './icons.ts';
import { activeJobCount, useApp } from './store.ts';
import { BatchPage } from './components/BatchPage.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Home } from './components/Home.tsx';
import { JobPanel } from './components/JobPanel.tsx';
import { PipelinePage } from './components/PipelinePage.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { SignPage } from './components/SignPage.tsx';
import { ToolPage } from './components/ToolPage.tsx';
import { UpdatePrompt } from './components/UpdatePrompt.tsx';
import { Badge, Button } from './components/ui.tsx';

// pdfjs-dist is only needed once someone actually opens a preview, so the
// Viewer (and its ~1MB dependency) load as a separate chunk, not the main bundle.
const Viewer = lazy(() =>
  import('./components/Viewer.tsx').then((module) => ({ default: module.Viewer })),
);

type MainView =
  | { name: 'welcome' }
  | { name: 'tool'; toolId: string; initialFile?: PickedFile }
  | { name: 'viewer'; file: PickedFile }
  | { name: 'settings' };

export function App() {
  const ready = useApp((s) => s.ready);
  const locale = useApp((s) => s.locale);
  const jobs = useApp((s) => s.jobs);
  const startupError = useApp((s) => s.startupError);
  const initialize = useApp((s) => s.initialize);

  const [main, setMain] = useState<MainView>({ name: 'welcome' });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Set while the palette was opened from the Viewer's "Choose a tool" button,
  // so picking a tool there both scopes the results to PDF-accepting tools and
  // carries the already-open file straight into the tool page.
  const [viewerPaletteFile, setViewerPaletteFile] = useState<PickedFile | null>(null);
  const [jobsOpen, setJobsOpen] = useState(false);
  // The Viewer's edits live in its own state, so leaving would drop them. It
  // reports dirtiness up and the shell holds any navigation until confirmed.
  const [viewerDirty, setViewerDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  /**
   * Runs `action`, unless the Viewer has unsaved edits — then it is held until
   * the user confirms. Every route out of the Viewer goes through this.
   */
  const guarded = useCallback(
    (action: () => void) => {
      if (viewerDirty) setPendingNav(() => action);
      else action();
    },
    [viewerDirty],
  );

  const openTool = useCallback(
    (toolId: string) => {
      guarded(() => {
        setPaletteOpen(false);
        setMain({ name: 'tool', toolId });
      });
    },
    [guarded],
  );

  const onPaletteSelect = useCallback(
    (toolId: string) => {
      setPaletteOpen(false);
      const file = viewerPaletteFile;
      setViewerPaletteFile(null);
      // Coming from the Viewer the edits travel with the file, so nothing is
      // lost and the unsaved-changes guard would only be noise.
      if (file) {
        setMain({ name: 'tool', toolId, initialFile: file });
        return;
      }
      guarded(() => setMain({ name: 'tool', toolId }));
    },
    [guarded, viewerPaletteFile],
  );

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setViewerPaletteFile(null);
  }, []);

  const openWelcome = useCallback(() => {
    guarded(() => setMain({ name: 'welcome' }));
  }, [guarded]);

  const openSettings = useCallback(() => {
    guarded(() => setMain({ name: 'settings' }));
  }, [guarded]);

  const openViewer = useCallback((file: PickedFile) => {
    setMain({ name: 'viewer', file });
  }, []);

  const openViewerPicker = useCallback(async () => {
    const [file] = await bridge().pickFiles(['.pdf'], false);
    if (file) openViewer(file);
  }, [openViewer]);

  const openToolPickerFor = useCallback((file: PickedFile) => {
    setViewerPaletteFile(file);
    setPaletteOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        // ⌘K always means "search everything" — drop any Viewer scoping.
        setViewerPaletteFile(null);
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') {
        setPaletteOpen(false);
        setViewerPaletteFile(null);
        setJobsOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
  const tool = main.name === 'tool' ? uiRegistry.tryGet(main.toolId) : undefined;
  const showSidebar = main.name !== 'settings';

  return (
    <div className="flex h-full flex-col">
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

      <div className="flex min-h-0 flex-1">
        {showSidebar && (
          <Sidebar
            activeToolId={main.name === 'tool' ? main.toolId : null}
            onSelectHome={openWelcome}
            onSelectTool={openTool}
          />
        )}

        <main
          className={clsx(
            'min-h-0 flex-1 bg-[var(--surface-app)]',
            main.name === 'settings' || main.name === 'viewer' ? 'overflow-hidden' : 'overflow-y-auto',
          )}
        >
          {main.name === 'settings' && <SettingsPanel onBack={openWelcome} />}

          {main.name === 'viewer' && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Loader2 size={22} className="animate-spin text-[var(--text-muted)]" />
                </div>
              }
            >
              <Viewer
                key={`${main.file.path}|${main.file.name}|${main.file.size}`}
                file={main.file}
                onChooseTool={openToolPickerFor}
                onDirtyChange={setViewerDirty}
              />
            </Suspense>
          )}

          {main.name === 'tool' &&
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
                  initialFile={main.initialFile}
                  onPreviewFile={openViewer}
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

          {main.name === 'welcome' && (
            <Home
              onOpenTool={openTool}
              onOpenSearch={() => setPaletteOpen(true)}
              onOpenCategory={(_categoryId: CategoryId) => {
                // Categories live in the drawer; keep welcome and let the user expand there.
                openWelcome();
              }}
              onOpenPreview={openViewerPicker}
            />
          )}
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          onSelect={onPaletteSelect}
          filterAccept={viewerPaletteFile ? '.pdf' : undefined}
        />
      )}
      <JobPanel open={jobsOpen} onClose={() => setJobsOpen(false)} />
      <UpdatePrompt />

      {pendingNav && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
          role="presentation"
        >
          <div
            className="w-full max-w-sm space-y-4 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-panel)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={t('viewerDiscardTitle', locale)}
          >
            <div>
              <h2 className="text-sm font-semibold">{t('viewerDiscardTitle', locale)}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                {t('viewerDiscardHint', locale)}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPendingNav(null)}>
                {t('viewerDiscardStay', locale)}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  const go = pendingNav;
                  setPendingNav(null);
                  setViewerDirty(false);
                  go();
                }}
              >
                {t('viewerDiscardLeave', locale)}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
