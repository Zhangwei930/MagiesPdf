import { useCallback, useEffect, useState } from 'react';
import { bridge, hasBridge, type WebSearchStatus } from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import { AlertCircle, Globe } from '../icons.ts';
import { Button, Field } from './ui.tsx';
import { IconPlate, SettingCard, SettingRow, SettingsSection, StatusPill, Toggle } from './settingsUi.tsx';

/**
 * The one tool that reaches the public internet.
 *
 * The pane reports what the Agent will actually be offered, which is decided in
 * `electron/ai/webSearch.cjs`: without a key (or a SearXNG address) the tool is
 * not in the list at all, and strict local privacy withdraws it whatever is
 * configured here. Saying "on" while the tool is absent would be a lie the user
 * only discovers mid-task.
 */
export function AiWebSearch({
  locale,
  webSearch,
  onChange,
  onError,
}: {
  locale: Locale;
  webSearch: { enabled: boolean; provider: string; endpoint: string };
  onChange(next: { enabled: boolean; provider: string; endpoint: string }): void;
  onError(message: string): void;
}) {
  const [status, setStatus] = useState<WebSearchStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    if (!hasBridge()) return;
    void bridge()
      .getWebSearchStatus()
      .then(setStatus)
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
  }, [onError]);

  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    void bridge()
      .getWebSearchStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) onError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [onError, webSearch]);

  const presets = status?.presets ?? [];
  const preset = presets.find((entry) => entry.id === webSearch.provider) ?? null;
  const needsKey = preset?.requiresApiKey === true;
  const needsEndpoint = preset?.id === 'searxng';
  const keyStored = status?.apiKeyConfigured === true;

  const ready = webSearch.enabled
    && Boolean(preset)
    && (!needsKey || keyStored)
    && (!needsEndpoint || webSearch.endpoint.trim() !== '')
    && status?.blockedByPrivacy !== true;

  const saveKey = (value: string) => {
    if (!hasBridge()) return;
    setSaving(true);
    onError('');
    void bridge()
      .setWebSearchKey(value)
      .then(() => {
        setApiKey('');
        refresh();
      })
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="space-y-4">
      <SettingCard>
        <div className="flex items-center gap-3">
          <IconPlate icon={Globe} tone={ready ? 'success' : 'neutral'} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-semibold">
              {locale === 'zh' ? '联网搜索' : 'Web search'}
            </div>
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              {locale === 'zh'
                ? '开启后 AI 多一个搜索工具。每次调用都需要你确认，搜索词会离开本机。'
                : 'Gives the assistant one search tool. Every call asks first, and the query leaves this machine.'}
            </div>
          </div>
          <StatusPill tone={ready ? 'success' : 'neutral'} pulse={ready}>
            {ready
              ? (locale === 'zh' ? '可以使用' : 'Ready')
              : (locale === 'zh' ? '未启用' : 'Off')}
          </StatusPill>
        </div>

        {status?.blockedByPrivacy && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-[var(--warning-soft)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--warning)]">
            <AlertCircle size={13} className="mt-px shrink-0" />
            <span>
              {locale === 'zh'
                ? '「严格本地隐私」已开启，联网搜索工具不会提供给模型——即使这里配置好了。'
                : 'Strict local privacy is on, so the search tool is withheld from the model even when configured here.'}
            </span>
          </p>
        )}
      </SettingCard>

      <SettingsSection title={locale === 'zh' ? '搜索服务' : 'Search service'}>
        <SettingCard divided>
          <SettingRow
            label={locale === 'zh' ? '启用联网搜索' : 'Enable web search'}
            description={locale === 'zh'
              ? '关闭时模型看不到这个工具，不会尝试调用。'
              : 'While off, the model is not told the tool exists and will not try it.'}
          >
            <Toggle
              checked={webSearch.enabled}
              disabled={!hasBridge()}
              ariaLabel={locale === 'zh' ? '启用联网搜索' : 'Enable web search'}
              onChange={(enabled) => onChange({ ...webSearch, enabled })}
            />
          </SettingRow>

          <SettingRow label={locale === 'zh' ? '服务商' : 'Provider'}>
            <select
              className="field-input w-52 text-[13px]"
              value={webSearch.provider}
              aria-label={locale === 'zh' ? '搜索服务商' : 'Search provider'}
              onChange={(event) => onChange({ ...webSearch, provider: event.target.value })}
            >
              {presets.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </SettingRow>
        </SettingCard>
      </SettingsSection>

      {preset && (
        <SettingCard className="space-y-3">
          <p className="text-[12.5px] text-[var(--text-muted)]">{preset.hint[locale]}</p>

          {needsEndpoint && (
            <Field
              label={locale === 'zh' ? '实例地址' : 'Instance address'}
              help={locale === 'zh'
                ? '你自己的 SearXNG 地址，例如 http://127.0.0.1:8080。'
                : 'Your own SearXNG address, for example http://127.0.0.1:8080.'}
            >
              <input
                className="field-input font-mono text-[13px]"
                value={webSearch.endpoint}
                placeholder="http://127.0.0.1:8080"
                onChange={(event) => onChange({ ...webSearch, endpoint: event.target.value })}
              />
            </Field>
          )}

          {needsKey && (
            <Field
              label={t('aiApiKey', locale)}
              help={keyStored ? t('aiApiKeyConfigured', locale) : t('aiApiKeyNotConfigured', locale)}
            >
              <div className="flex gap-2">
                <input
                  type="password"
                  className="field-input font-mono text-[13px]"
                  value={apiKey}
                  autoComplete="off"
                  placeholder={keyStored ? '••••••••••••' : 'tvly-…'}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="primary"
                  loading={saving}
                  disabled={!apiKey || !hasBridge()}
                  onClick={() => saveKey(apiKey)}
                >
                  {t('aiApiKeySave', locale)}
                </Button>
                {keyStored && (
                  <Button size="sm" variant="ghost" disabled={saving} onClick={() => saveKey('')}>
                    {t('clear', locale)}
                  </Button>
                )}
              </div>
            </Field>
          )}
        </SettingCard>
      )}
    </div>
  );
}
