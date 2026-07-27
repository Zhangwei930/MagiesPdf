import { useCallback, useEffect, useState } from 'react';
import type { CategoryId } from '@core/types.ts';
import { uiRegistry } from './catalog.ts';
import { hasBridge } from './bridge.ts';
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
import { Badge } from './components/ui.tsx';

type MainView =
  | { name: 'welcome' }
  | { name: 'tool'; toolId: string }
  | { name: 'settings' };

export function App() {
  const ready = useApp((s) => s.ready);
  const locale = useApp((s) => s.locale);
  const jobs = useApp((s) => s.jobs);
  const startupError = useApp((s) => s.startupError);
  const initialize = useApp((s) => s.initialize);

  const [main, setMain] = useState<MainView>({ name: 'welcome' });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const openTool = useCallback((toolId: string) => {
    setPaletteOpen(false);
    setMain({ name: 'tool', toolId });
  }, []);

  const openWelcome = useCallback(() => {
    setMain({ name: 'welcome' });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') {
        setPaletteOpen(false);
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
          onClick={() => setMain({ name: 'settings' })}
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
            onOpenSearch={() => setPaletteOpen(true)}
          />
        )}

        <main className="min-h-0 flex-1 overflow-y-auto bg-[var(--surface-app)]">
          {main.name === 'settings' && <SettingsPanel onBack={openWelcome} />}

          {main.name === 'tool' &&
            (tool ? (
              tool.id === 'advanced.pipeline' ? (
                <PipelinePage key={tool.id} tool={tool} onBack={openWelcome} />
              ) : tool.id === 'advanced.batch' ? (
                <BatchPage key={tool.id} tool={tool} onBack={openWelcome} />
              ) : tool.id === 'security.add-signature' ? (
                <SignPage key={tool.id} tool={tool} onBack={openWelcome} />
              ) : (
                <ToolPage key={tool.id} tool={tool} onBack={openWelcome} />
              )
            ) : (
              <Home
                onOpenTool={openTool}
                onOpenSearch={() => setPaletteOpen(true)}
                onOpenCategory={(_categoryId: CategoryId) => openWelcome()}
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
            />
          )}
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onSelect={openTool} />
      )}
      <JobPanel open={jobsOpen} onClose={() => setJobsOpen(false)} />
    </div>
  );
}
