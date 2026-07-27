import { useEffect, useState } from 'react';
import { bridge, hasBridge, type UpdaterStatus } from '../bridge.ts';
import { t } from '../i18n.ts';
import { useApp } from '../store.ts';
import { Button, ProgressBar } from './ui.tsx';

/**
 * Global update prompt (MagiesTerminal-style):
 * pops when an update is available / downloading / ready, with progress and
 * restart-to-install — not only inside Settings.
 */
export function UpdatePrompt() {
  const locale = useApp((s) => s.locale);
  const [status, setStatus] = useState<UpdaterStatus>({ state: 'idle' });
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!hasBridge()) return;
    return bridge().onUpdaterStatus((next) => {
      setStatus(next);
      if (
        next.state === 'available' ||
        next.state === 'downloading' ||
        next.state === 'ready'
      ) {
        if (next.version && next.version === dismissedVersion && next.state === 'available') {
          return;
        }
        setOpen(true);
      }
    });
  }, [dismissedVersion]);

  if (!open) return null;
  if (
    status.state !== 'available' &&
    status.state !== 'downloading' &&
    status.state !== 'ready'
  ) {
    return null;
  }

  const percent = (() => {
    if (status.state === 'ready') return 1;
    if (status.state === 'downloading' && status.message) {
      const n = Number.parseInt(status.message.replace('%', ''), 10);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0;
    }
    return 0;
  })();

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        aria-label={t('close', locale)}
        onClick={() => {
          if (status.state === 'available') {
            setDismissedVersion(status.version ?? null);
            setOpen(false);
          }
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-app)] shadow-xl"
      >
        <div className="space-y-3 px-5 py-4">
          <h2 className="text-[15px] font-semibold tracking-tight">
            {status.state === 'ready'
              ? t('updatesReady', locale)
              : status.state === 'downloading'
                ? t('updatesDownloading', locale)
                : t('updatesAvailable', locale)}
            {status.version ? (
              <span className="ml-2 font-mono text-[13px] text-[var(--accent)]">
                v{status.version}
              </span>
            ) : null}
          </h2>

          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {status.state === 'ready'
              ? t('updatePromptReadyHint', locale)
              : status.state === 'downloading'
                ? t('updatePromptDownloadHint', locale)
                : t('updatePromptAvailableHint', locale)}
          </p>

          {(status.state === 'downloading' || status.state === 'ready') && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] text-[var(--text-muted)]">
                <span>{t('updatesDownloading', locale)}</span>
                <span className="font-mono">{Math.round(percent * 100)}%</span>
              </div>
              <ProgressBar value={percent} />
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {status.state === 'available' && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDismissedVersion(status.version ?? null);
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
                onClick={() => void bridge().installUpdate()}
              >
                {t('updatesInstall', locale)}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
