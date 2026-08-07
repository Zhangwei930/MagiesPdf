import { useCallback, useEffect, useState } from 'react';
import { bridge, hasBridge, type ImageProviderStatus } from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import { AlertCircle, Images } from '../icons.ts';
import { Button, Field } from './ui.tsx';
import { IconPlate, SettingCard, SettingRow, SettingsSection, StatusPill, Toggle } from './settingsUi.tsx';

/** "Whatever the configured model provider can serve", resolved in the main process. */
const AUTO_PROVIDER = 'auto';

export interface ImageSettings {
  enabled: boolean;
  provider: string;
  endpoint: string;
  model: string;
}

/**
 * Where a picture comes from when the Agent needs one.
 *
 * Same contract as the search pane: what is reported here is what
 * `electron/ai/imageSearch.cjs` will actually offer the model — without a key
 * the tool is not in the list, and strict local privacy withdraws it whatever
 * is configured. The two kinds are not interchangeable and the difference is
 * worth showing: a stock library returns a photograph but is not reliably
 * reachable from mainland China, and a generator draws anything but never
 * returns a real place.
 */
export function AiImages({
  locale,
  images,
  onChange,
  onError,
}: {
  locale: Locale;
  images: ImageSettings;
  onChange(next: ImageSettings): void;
  onError(message: string): void;
}) {
  const [status, setStatus] = useState<ImageProviderStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    if (!hasBridge()) return;
    void bridge()
      .getImageProviderStatus()
      .then(setStatus)
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
  }, [onError]);

  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    void bridge()
      .getImageProviderStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) onError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [onError, images]);

  const presets = status?.presets ?? [];
  const auto = images.provider === AUTO_PROVIDER;
  const borrowed = status?.followsModelProvider ?? null;
  const preset = presets.find((entry) => entry.id === images.provider) ?? null;
  const needsKey = !auto && preset?.requiresApiKey === true;
  const needsModel = !auto && preset?.requiresModel === true;
  // Only the self-named endpoint has nowhere to get an address from.
  const needsEndpoint = !auto && preset !== null && preset.endpoint === '';
  const keyStored = status?.apiKeyConfigured === true;
  const model = images.model || preset?.defaultModel || '';

  const ready = images.enabled
    && status?.blockedByPrivacy !== true
    && (auto
      ? borrowed !== null
      : Boolean(preset)
        && (!needsKey || keyStored)
        && (!needsModel || model.trim() !== '')
        && (!needsEndpoint || images.endpoint.trim() !== ''));

  /** Switching provider carries its defaults over; a stale model reaches nothing. */
  const selectProvider = (providerId: string) => {
    if (providerId === AUTO_PROVIDER) {
      onChange({ ...images, provider: AUTO_PROVIDER, endpoint: '', model: '' });
      return;
    }
    const next = presets.find((entry) => entry.id === providerId) ?? null;
    onChange({
      ...images,
      provider: providerId,
      endpoint: next?.endpoint ?? '',
      model: next?.defaultModel ?? '',
    });
  };

  const saveKey = (value: string) => {
    if (!hasBridge()) return;
    setSaving(true);
    onError('');
    void bridge()
      .setImageProviderKey(value)
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
          <IconPlate icon={Images} tone={ready ? 'success' : 'neutral'} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-semibold">
              {locale === 'zh' ? '文档配图' : 'Document pictures'}
            </div>
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              {locale === 'zh'
                ? '开启后 AI 能为幻灯片和文稿取一张配图，存进已授权的文件夹。描述会离开本机。'
                : 'Lets the assistant fetch a picture for a deck or a document into the granted folder. The description leaves this machine.'}
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
                ? '「严格本地隐私」已开启，配图工具不会提供给模型——即使这里配置好了。'
                : 'Strict local privacy is on, so the picture tool is withheld from the model even when configured here.'}
            </span>
          </p>
        )}
      </SettingCard>

      <SettingsSection title={locale === 'zh' ? '图片来源' : 'Picture source'}>
        <SettingCard divided>
          <SettingRow
            label={locale === 'zh' ? '启用配图' : 'Enable pictures'}
            description={locale === 'zh'
              ? '关闭时模型看不到这个工具，做出来的幻灯片只有文字。'
              : 'While off the model is not told the tool exists, and its decks stay text-only.'}
          >
            <Toggle
              checked={images.enabled}
              disabled={!hasBridge()}
              ariaLabel={locale === 'zh' ? '启用配图' : 'Enable pictures'}
              onChange={(enabled) => onChange({ ...images, enabled })}
            />
          </SettingRow>

          <SettingRow label={locale === 'zh' ? '服务商' : 'Provider'}>
            <select
              className="field-input w-52 text-[13px]"
              value={images.provider}
              aria-label={locale === 'zh' ? '图片服务商' : 'Picture provider'}
              onChange={(event) => selectProvider(event.target.value)}
            >
              <option value={AUTO_PROVIDER}>
                {locale === 'zh' ? '跟随模型服务商' : 'Follow the model provider'}
              </option>
              {presets.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </SettingRow>
        </SettingCard>
      </SettingsSection>

      {auto && (
        <SettingCard className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {locale === 'zh'
              ? '用你已经配置好的模型服务商出图，不需要第二个 key。它的额度会被算在你头上；不想这样就在上面选一个单独的服务商，或者关掉配图。'
              : 'Uses the model provider you already configured, so there is no second key. Its quota is yours to spend — pick a separate provider above, or turn pictures off, if you would rather it were not.'}
          </p>
          {borrowed ? (
            <p className="break-all font-mono text-[11.5px] text-[var(--text-muted)]">
              {borrowed.endpoint} · {borrowed.model}
            </p>
          ) : (
            <p className="flex items-start gap-2 rounded-lg bg-[var(--warning-soft)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--warning)]">
              <AlertCircle size={13} className="mt-px shrink-0" />
              <span>
                {locale === 'zh'
                  ? '当前模型服务商不提供出图接口，所以这个工具不会给模型。幻灯片仍会用主题图形代替配图，不影响生成。'
                  : 'The configured model provider serves no images, so the tool is withheld. Slides still use a drawn themed figure in place of a picture.'}
              </span>
            </p>
          )}
        </SettingCard>
      )}

      {preset && (
        <SettingCard className="space-y-3">
          <div className="flex items-center gap-2">
            <StatusPill tone="neutral">
              {preset.kind === 'search'
                ? (locale === 'zh' ? '图库搜索' : 'Stock search')
                : (locale === 'zh' ? '按描述生成' : 'Generated')}
            </StatusPill>
            <p className="text-[12.5px] text-[var(--text-muted)]">{preset.hint[locale]}</p>
          </div>

          {needsEndpoint && (
            <Field
              label={locale === 'zh' ? '接口地址' : 'Endpoint'}
              help={locale === 'zh'
                ? '任何 OpenAI 兼容的 /images/generations 地址。'
                : 'Any OpenAI-compatible /images/generations address.'}
            >
              <input
                className="field-input font-mono text-[13px]"
                value={images.endpoint}
                placeholder="https://…/v1/images/generations"
                onChange={(event) => onChange({ ...images, endpoint: event.target.value })}
              />
            </Field>
          )}

          {needsModel && (
            <Field
              label={locale === 'zh' ? '模型' : 'Model'}
              help={locale === 'zh'
                ? '生成图片的模型名，按服务商的写法填。'
                : "The image model's id, spelled the way this provider spells it."}
            >
              <input
                className="field-input font-mono text-[13px]"
                value={images.model}
                placeholder={preset.defaultModel || 'cogview-3-flash'}
                onChange={(event) => onChange({ ...images, model: event.target.value })}
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
                  placeholder={keyStored ? '••••••••••••' : 'sk-…'}
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
