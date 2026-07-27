import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { bridge, hasBridge, type UpdaterStatus } from '../bridge.ts';
import { t } from '../i18n.ts';
import { ArrowLeft, Languages, Monitor, Moon, Sun } from '../icons.ts';
import { useApp } from '../store.ts';
import { Button, Field } from './ui.tsx';

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function updaterLabel(status: UpdaterStatus, locale: 'zh' | 'en'): string {
  switch (status.state) {
    case 'checking':
      return t('updatesChecking', locale);
    case 'current':
      return status.message === 'dev-build'
        ? t('updatesDevNote', locale)
        : t('updatesCurrent', locale);
    case 'available':
      return `${t('updatesAvailable', locale)}${status.version ? ` ${status.version}` : ''}`;
    case 'downloading':
      return `${t('updatesDownloading', locale)}${status.message ? ` ${status.message}` : ''}`;
    case 'ready':
      return `${t('updatesReady', locale)}${status.version ? ` ${status.version}` : ''}`;
    case 'error':
      return `${t('updatesError', locale)}${status.message ? `：${status.message}` : ''}`;
    default:
      return t('updatesIdle', locale);
  }
}

export function SettingsPanel({ onBack }: { onBack(): void }) {
  const locale = useApp((s) => s.locale);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const [apiStatus, setApiStatus] = useState({ running: false, address: '', enabled: false });
  const [appVersion, setAppVersion] = useState(hasBridge() ? '' : '1.0.0');
  const [packaged, setPackaged] = useState(false);
  const [updater, setUpdater] = useState<UpdaterStatus>({ state: 'idle' });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await bridge().getApiStatus();
        if (!cancelled) setApiStatus(status);
      } catch {
        // Desktop-only surface; ignore in browser preview.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [settings.api]);

  useEffect(() => {
    if (!hasBridge()) return;
    void bridge()
      .getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(bridge().version || '1.0.0'));
    void bridge()
      .isPackaged()
      .then(setPackaged)
      .catch(() => setPackaged(false));
    return bridge().onUpdaterStatus((status) => {
      setUpdater(status);
      setChecking(false);
    });
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-6">
      <header className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="px-2">
          <ArrowLeft size={16} />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{t('settings', locale)}</h1>
      </header>

      <div className="space-y-5">
        <section className="surface-panel space-y-4 p-4">
          <Field label={t('theme', locale)}>
            <div className="flex gap-2">
              {(
                [
                  ['system', Monitor, 'themeSystem'],
                  ['light', Sun, 'themeLight'],
                  ['dark', Moon, 'themeDark'],
                ] as const
              ).map(([value, Icon, labelKey]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => void update({ theme: value })}
                  className={clsx(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] transition-colors',
                    settings.theme === value
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'border-[var(--border-subtle)] bg-[var(--surface-sunken)] hover:border-[var(--border-strong)]',
                  )}
                >
                  <Icon size={14} />
                  {t(labelKey, locale)}
                </button>
              ))}
            </div>
          </Field>

          <Field label={t('language', locale)}>
            <div className="flex gap-2">
              {(
                [
                  ['zh', '中文'],
                  ['en', 'English'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => void update({ locale: value })}
                  className={clsx(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] transition-colors',
                    settings.locale === value
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'border-[var(--border-subtle)] bg-[var(--surface-sunken)] hover:border-[var(--border-strong)]',
                  )}
                >
                  <Languages size={14} />
                  {label}
                </button>
              ))}
            </div>
          </Field>
        </section>

        <section className="surface-panel space-y-4 p-4">
          <Field label={t('updatesSection', locale)} help={t('updatesHelp', locale)}>
            <p className="mb-2 text-[12px] text-[var(--text-secondary)]">
              {t('updatesCurrentVersion', locale)}:{' '}
              <span className="font-mono">{appVersion || '—'}</span>
              {!packaged && hasBridge() ? (
                <span className="ml-2 text-[var(--text-muted)]">({t('updatesDevNote', locale)})</span>
              ) : null}
            </p>
            <p className="mb-3 text-[12px] text-[var(--text-muted)]">{updaterLabel(updater, locale)}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={checking || updater.state === 'checking'}
                disabled={!hasBridge()}
                onClick={() => {
                  setChecking(true);
                  setUpdater({ state: 'checking' });
                  void bridge()
                    .checkForUpdates()
                    .catch((error: unknown) => {
                      setChecking(false);
                      setUpdater({
                        state: 'error',
                        message: error instanceof Error ? error.message : String(error),
                      });
                    });
                }}
              >
                {t('updatesCheck', locale)}
              </Button>
              {updater.state === 'available' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setUpdater({ ...updater, state: 'downloading' });
                    void bridge()
                      .downloadUpdate()
                      .catch((error: unknown) => {
                        setUpdater({
                          state: 'error',
                          message: error instanceof Error ? error.message : String(error),
                        });
                      });
                  }}
                >
                  {t('updatesDownload', locale)}
                </Button>
              )}
              {updater.state === 'ready' && (
                <Button size="sm" variant="primary" onClick={() => void bridge().installUpdate()}>
                  {t('updatesInstall', locale)}
                </Button>
              )}
            </div>
          </Field>
        </section>

        <section className="surface-panel space-y-4 p-4">
          <Field label={t('outputDirectory', locale)} help={t('outputDirectoryHelp', locale)}>
            <div className="flex gap-2">
              <input
                className="field-input font-mono text-xs"
                readOnly
                value={settings.defaultOutputDirectory}
                placeholder="—"
              />
              <Button
                size="sm"
                onClick={async () => {
                  const directory = await bridge().pickDirectory();
                  if (directory) await update({ defaultOutputDirectory: directory });
                }}
              >
                {t('browse', locale)}
              </Button>
              {settings.defaultOutputDirectory && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void update({ defaultOutputDirectory: '' })}
                >
                  {t('clear', locale)}
                </Button>
              )}
            </div>
          </Field>

          <Field label={t('onCollision', locale)}>
            <select
              className="field-input"
              value={settings.onNameCollision}
              onChange={(e) =>
                void update({ onNameCollision: e.target.value as 'rename' | 'overwrite' })
              }
            >
              <option value="rename">{t('collisionRename', locale)}</option>
              <option value="overwrite">{t('collisionOverwrite', locale)}</option>
            </select>
          </Field>
        </section>

        <section className="surface-panel space-y-4 p-4">
          <Field label={t('externalConverter', locale)} help={t('externalConverterHelp', locale)}>
            <p className="mb-2 text-[12px] text-[var(--text-tertiary)]">
              {settings.externalConverter.executable
                ? t('externalConverterConfigured', locale)
                : t('externalConverterNotConfigured', locale)}
            </p>
          </Field>

          <Field label={t('externalConverterExecutable', locale)}>
            <div className="flex gap-2">
              <input
                className="field-input font-mono text-xs"
                value={settings.externalConverter.executable}
                placeholder="/path/to/converter"
                onChange={(e) =>
                  void update({
                    externalConverter: {
                      ...settings.externalConverter,
                      executable: e.target.value,
                    },
                  })
                }
              />
              <Button
                size="sm"
                onClick={async () => {
                  const files = await bridge().pickFiles(['*'], false);
                  const picked = files[0];
                  if (picked?.path) {
                    await update({
                      externalConverter: {
                        ...settings.externalConverter,
                        executable: picked.path,
                      },
                    });
                  }
                }}
              >
                {t('browse', locale)}
              </Button>
              {settings.externalConverter.executable && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void update({
                      externalConverter: { ...settings.externalConverter, executable: '' },
                    })
                  }
                >
                  {t('clear', locale)}
                </Button>
              )}
            </div>
          </Field>

          <Field
            label={t('externalConverterArgs', locale)}
            help={t('externalConverterArgsHelp', locale)}
          >
            <input
              className="field-input font-mono text-xs"
              value={settings.externalConverter.argumentTemplate}
              placeholder="--convert-to pdf --outdir {out} {in}"
              onChange={(e) =>
                void update({
                  externalConverter: {
                    ...settings.externalConverter,
                    argumentTemplate: e.target.value,
                  },
                })
              }
            />
          </Field>

          <Field label={t('externalConverterTimeout', locale)}>
            <div className="flex items-center gap-2">
              <input
                type="number"
                className="field-input w-32"
                min={5}
                max={600}
                step={5}
                value={Math.round(settings.externalConverter.timeoutMs / 1000)}
                onChange={(e) => {
                  const seconds = Math.max(5, Math.min(600, Number(e.target.value) || 120));
                  void update({
                    externalConverter: {
                      ...settings.externalConverter,
                      timeoutMs: seconds * 1000,
                    },
                  });
                }}
              />
              <span className="text-[12px] text-[var(--text-tertiary)]">s</span>
            </div>
          </Field>
        </section>

        <section className="surface-panel space-y-4 p-4">
          <Field label={t('apiSection', locale)} help={t('apiSectionHelp', locale)}>
            <p className="mb-2 text-[12px] text-[var(--text-tertiary)]">
              {apiStatus.running
                ? `${t('apiStatusRunning', locale)} · ${apiStatus.address || '—'}`
                : t('apiStatusStopped', locale)}
            </p>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={settings.api.enabled}
                onChange={(e) =>
                  void update({
                    api: { ...settings.api, enabled: e.target.checked },
                  })
                }
              />
              {t('apiEnabled', locale)}
            </label>
          </Field>

          <Field label={t('apiPort', locale)}>
            <input
              type="number"
              className="field-input w-32"
              min={1024}
              max={65535}
              value={settings.api.port}
              onChange={(e) => {
                const port = Math.max(1024, Math.min(65535, Number(e.target.value) || 8737));
                void update({ api: { ...settings.api, port } });
              }}
            />
          </Field>

          <Field label={t('apiToken', locale)} help={t('apiTokenHelp', locale)}>
            <div className="flex gap-2">
              <input
                className="field-input font-mono text-xs"
                value={settings.api.token}
                placeholder="—"
                onChange={(e) =>
                  void update({ api: { ...settings.api, token: e.target.value } })
                }
              />
              <Button
                size="sm"
                onClick={() =>
                  void update({ api: { ...settings.api, token: randomToken() } })
                }
              >
                {t('apiGenerateToken', locale)}
              </Button>
            </div>
          </Field>

          <Field label={t('apiAllowLan', locale)} help={t('apiAllowLanHelp', locale)}>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={settings.api.allowLan}
                onChange={(e) =>
                  void update({
                    api: { ...settings.api, allowLan: e.target.checked },
                  })
                }
              />
              {t('apiAllowLan', locale)}
            </label>
          </Field>

          {apiStatus.running && apiStatus.address && (
            <Field label={t('apiEndpoint', locale)}>
              <code className="block break-all rounded-md bg-[var(--surface-sunken)] px-2 py-1.5 font-mono text-[12px]">
                {apiStatus.address}/v1
              </code>
            </Field>
          )}
        </section>
      </div>
    </div>
  );
}
