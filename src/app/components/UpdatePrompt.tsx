import { useEffect, useState } from 'react';
import { bridge, hasBridge, type UpdaterStatus } from '../bridge.ts';
import { t } from '../i18n.ts';
import { useApp } from '../store.ts';
import { isActionable, shouldShowToast, type Dismissal } from '../updateToast.ts';
import { Button, ProgressBar } from './ui.tsx';

/**
 * Bottom-right update toast (MagiesTerminal-style):
 * auto-check + auto-download when enabled, progress, then restart-to-install.
 * Non-modal so Settings remains usable while the update is ready.
 */
/**
 * The macOS install unpacks ~800 MB and swaps a 2 GB bundle. It used to do
 * that with the main process stopped, so the window went unresponsive and the
 * only thing moving was this toast's spinner — in the renderer, which knew
 * nothing. Naming the stage is what makes the wait legible.
 */
const INSTALL_STAGE_KEYS: Record<string, 'updateStagePreparing' | 'updateStageExtracting' | 'updateStageInstalling' | 'updateStageFinishing'> = {
  preparing: 'updateStagePreparing',
  extracting: 'updateStageExtracting',
  installing: 'updateStageInstalling',
  finishing: 'updateStageFinishing',
};

export function UpdatePrompt() {
  const locale = useApp((s) => s.locale);
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' });
  const [dismissed, setDismissed] = useState<Dismissal | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBridge()) return;

    const apply = (next: UpdaterStatus) => {
      setStatus(next);
      if (!shouldShowToast(next, dismissed)) return;
      setOpen(true);
      if (next.state === 'ready') setInstallError(null);
    };

    void bridge()
      .getUpdaterStatus?.()
      .then((snap) => {
        if (snap && isActionable(snap.state)) apply(snap);
      })
      .catch(() => {
        // Older preloads without getUpdaterStatus — ignore.
      });

    return bridge().onUpdaterStatus(apply);
  }, [dismissed]);

  if (!open) return null;
  if (!isActionable(status.state) && status.state !== 'error') return null;

  const percent = (() => {
    if (status.state === 'ready') return 1;
    if (status.state === 'downloading' && status.message) {
      const n = Number.parseInt(status.message.replace('%', ''), 10);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0;
    }
    return 0;
  })();

  const title =
    status.state === 'installing'
      ? t('updatesInstalling', locale)
      : status.state === 'ready'
        ? t('updatesReady', locale)
        : status.state === 'downloading'
          ? t('updatesDownloading', locale)
          : status.state === 'error'
            ? t('updatesError', locale)
            : t('updatesAvailable', locale);

  const hint =
    status.state === 'installing'
      ? t(INSTALL_STAGE_KEYS[status.message ?? ''] ?? 'updateStagePreparing', locale)
      : status.state === 'ready'
        ? t('updatePromptReadyHint', locale)
        : status.state === 'downloading'
          ? t('updatePromptDownloadHint', locale)
          : status.state === 'error'
            ? status.message || installError || ''
            : t('updatePromptAvailableHint', locale);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[90] w-[min(100%-2rem,22rem)] overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-app)] shadow-xl"
    >
      <div className="space-y-3 px-4 py-3.5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-[14px] font-semibold tracking-tight">
            {title}
            {status.version ? (
              <span className="ml-2 font-mono text-[12px] text-[var(--accent)]">v{status.version}</span>
            ) : null}
          </h2>
          {/* Closable in every state, `ready` included: the toast is a notice,
              and Settings keeps the install button once it is gone. */}
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            aria-label={t('close', locale)}
            onClick={() => {
              setDismissed({ version: status.version ?? null, state: status.state });
              setOpen(false);
            }}
          >
            ×
          </button>
        </div>

        {hint ? (
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">{hint}</p>
        ) : null}

        {installError ? (
          <p className="text-[12px] leading-relaxed text-[var(--danger)]">{installError}</p>
        ) : null}

        {(status.state === 'downloading' || status.state === 'ready') && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-[11px] text-[var(--text-muted)]">
              <span>{status.state === 'ready' ? t('updatesReady', locale) : t('updatesDownloading', locale)}</span>
              <span className="font-mono">{Math.round(percent * 100)}%</span>
            </div>
            <ProgressBar value={percent} />
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-0.5">
          {status.state === 'available' && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDismissed({ version: status.version ?? null, state: status.state });
                  setOpen(false);
                }}
              >
                {t('updatePromptLater', locale)}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setStatus({ ...status, state: 'downloading', message: '0%' });
                  void bridge()
                    .downloadUpdate()
                    .catch((error: unknown) => {
                      setStatus({
                        state: 'error',
                        message: error instanceof Error ? error.message : String(error),
                      });
                    });
                }}
              >
                {t('updatesDownload', locale)}
              </Button>
            </>
          )}
          {status.state === 'downloading' && (
            <Button size="sm" variant="secondary" disabled>
              {t('updatesDownloading', locale)}
              {status.message ? ` ${status.message}` : ''}
            </Button>
          )}
          {status.state === 'ready' && (
            <Button
              size="sm"
              variant="primary"
              loading={installing}
              onClick={() => {
                setInstalling(true);
                setInstallError(null);
                void bridge()
                  .installUpdate()
                  .then((result) => {
                    if (!result || typeof result !== 'object' || result.success !== false) {
                      // success: app is quitting / relaunching
                      return;
                    }
                    setInstalling(false);
                    // Cancelling the unsaved-documents prompt is an answer,
                    // not a failure: nothing was installed and nothing broke.
                    if (result.cancelled) return;
                    setInstallError(result.error || t('updatesError', locale));
                  })
                  .catch((error: unknown) => {
                    setInstallError(error instanceof Error ? error.message : String(error));
                    setInstalling(false);
                  });
              }}
            >
              {t('updatesInstall', locale)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
