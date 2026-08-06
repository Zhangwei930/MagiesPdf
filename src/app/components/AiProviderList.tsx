import { useState } from 'react';
import { clsx } from 'clsx';
import { bridge, hasBridge, type AiProvider } from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import { Check, ChevronDown, PenLine, Plus, Trash2, X } from '../icons.ts';
import {
  PROVIDER_PRESETS,
  createProviderFromPreset,
  groupProviders,
  presetFor,
  type ProviderPreset,
  type ProviderTone,
} from '../ai/providers.ts';
import { vendorIcon } from '../ai/providerIcons.ts';
import { Button, Field } from './ui.tsx';
import { StatusPill, Toggle } from './settingsUi.tsx';

/**
 * The configured model providers: add from a vendor, edit endpoint and model,
 * store a key per provider, pick which one is in use.
 *
 * Keys never round-trip through this component — `bridge().setAiApiKey` writes
 * into the OS keychain and the main process only ever reports whether one
 * exists. That is why the key field is write-only and clears after saving.
 */

export const PRESET_PLATE: Record<ProviderTone, string> = {
  indigo: 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--accent)]',
  sky: 'bg-[color-mix(in_oklab,oklch(0.6_0.16_240)_16%,transparent)] text-[oklch(0.5_0.16_240)] dark:text-[oklch(0.75_0.14_240)]',
  emerald: 'bg-[var(--success-soft)] text-[var(--success)]',
  violet: 'bg-[color-mix(in_oklab,oklch(0.6_0.2_300)_16%,transparent)] text-[oklch(0.5_0.2_300)] dark:text-[oklch(0.76_0.16_300)]',
  amber: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  slate: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
};

const PLATE_SIZE = {
  sm: 'h-7 w-7 rounded-lg text-[10px]',
  md: 'h-10 w-10 rounded-xl text-[13px]',
  lg: 'h-12 w-12 rounded-2xl text-[15px]',
} as const;

// The glyph fills most of the tile: these are logos, and at a third of the
// plate they read as decoration rather than as the vendor's mark.
const GLYPH_SIZE = { sm: 'h-4.5 w-4.5', md: 'h-6 w-6', lg: 'h-7 w-7' } as const;

/**
 * A vendor's own logo where one ships, and the preset's two-letter badge where
 * one does not.
 *
 * The tile stays a neutral surface: these are the real marks, in the vendors'
 * own colours, and painting a coloured plate behind them fights with those
 * colours. Only the monochrome brands take a colour from here, and they take
 * the text colour so they invert with the theme instead of disappearing.
 *
 * `fill-current` on a mono glyph is load-bearing — several of these SVGs
 * declare no `fill` at all, so they paint black by default and no amount of
 * `color` reaches them.
 */
export function VendorMark({
  iconId,
  fallback,
  tone = 'slate',
  size = 'md',
  className,
}: {
  iconId: string;
  fallback: string;
  /** Only used for the fallback badge; a real logo carries its own colour. */
  tone?: ProviderTone;
  size?: keyof typeof PLATE_SIZE;
  className?: string;
}) {
  const icon = vendorIcon(iconId);

  if (!icon) {
    return (
      <span
        aria-hidden
        className={clsx('ai-plate font-semibold', PLATE_SIZE[size], PRESET_PLATE[tone], className)}
      >
        {fallback}
      </span>
    );
  }

  // The tile is a fixed light one in both themes, and a monochrome mark is
  // painted in its own black rather than the theme's text colour. A brand mark
  // that inverts with the interface is no longer that brand's mark — and the
  // black ones would otherwise vanish on a dark panel.
  return (
    <span
      aria-hidden
      className={clsx(
        'ai-plate bg-white',
        PLATE_SIZE[size],
        icon.mono && 'text-[#18181B]',
        className,
      )}
    >
      <span
        className={clsx(
          'block',
          GLYPH_SIZE[size],
          '[&>svg]:h-full [&>svg]:w-full',
          icon.mono && '[&_svg]:fill-current [&_path]:fill-current',
        )}
        dangerouslySetInnerHTML={{ __html: icon.svg }}
      />
    </span>
  );
}

export function ProviderPlate({
  provider,
  size = 'md',
}: {
  provider: AiProvider;
  size?: 'sm' | 'md' | 'lg';
}) {
  const preset = presetFor(provider.providerId);
  return (
    <VendorMark
      iconId={provider.providerId}
      fallback={preset?.mark ?? provider.name.trim().charAt(0).toUpperCase() ?? '?'}
      tone={preset?.tone ?? 'slate'}
      size={size}
    />
  );
}

function AddProviderMenu({ locale, onAdd }: { locale: Locale; onAdd(preset: ProviderPreset): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" onClick={() => setOpen((current) => !current)}>
        <Plus size={13} />
        {locale === 'zh' ? '添加服务商' : 'Add provider'}
        <ChevronDown size={11} className={clsx('transition-transform', open && 'rotate-180')} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 z-50 mt-1 max-h-[26rem] min-w-[280px] overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] py-1.5 shadow-[var(--shadow-card)]">
            {PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  onAdd(preset);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
              >
                <VendorMark iconId={preset.id} fallback={preset.mark} tone={preset.tone} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{preset.name}</span>
                  <span className="block truncate text-[11px] text-[var(--text-muted)]">
                    {preset.hint[locale]}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProviderEditor({
  provider,
  apiKeyConfigured,
  locale,
  onSave,
  onCancel,
  onError,
}: {
  provider: AiProvider;
  apiKeyConfigured: boolean;
  locale: Locale;
  onSave(next: AiProvider): void;
  onCancel(): void;
  onError(message: string): void;
}) {
  const preset = presetFor(provider.providerId);
  const [draft, setDraft] = useState<AiProvider>(provider);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyStored, setKeyStored] = useState(apiKeyConfigured);
  const suggestions = preset?.models ?? [];

  const saveKey = (value: string) => {
    if (!hasBridge()) return;
    setSavingKey(true);
    onError('');
    void bridge()
      .setAiApiKey(value, provider.id)
      .then((status) => {
        setKeyStored(status.apiKeyConfigured);
        setApiKey('');
      })
      .catch((cause: unknown) => {
        onError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setSavingKey(false));
  };

  return (
    <div className="space-y-3 border-t border-[var(--border-subtle)] px-3 py-3">
      <Field label={locale === 'zh' ? '名称' : 'Name'}>
        <input
          className="field-input text-[13px]"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>

      <Field label={t('aiBaseUrl', locale)}>
        <input
          className="field-input font-mono text-[13px]"
          value={draft.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
        />
      </Field>

      <Field
        label={t('aiModel', locale)}
        help={suggestions.length > 0
          ? (locale === 'zh' ? '可从下拉选，也可以直接改成别的模型名。' : 'Pick one or type any model name.')
          : (locale === 'zh' ? '填写该服务商的模型名称。' : "Enter this vendor's model name.")}
      >
        <div className="flex gap-2">
          <input
            className="field-input font-mono text-[13px]"
            value={draft.model}
            placeholder={suggestions[0] ?? 'model-name'}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
          {suggestions.length > 0 && (
            <select
              className="field-input w-36 shrink-0 text-[13px]"
              value={suggestions.includes(draft.model) ? draft.model : ''}
              aria-label={locale === 'zh' ? '选择模型' : 'Choose model'}
              onChange={(event) => {
                if (event.target.value) setDraft({ ...draft, model: event.target.value });
              }}
            >
              <option value="">{locale === 'zh' ? '选择…' : 'Choose…'}</option>
              {suggestions.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          )}
        </div>
      </Field>

      <Field
        label={locale === 'zh' ? '推理档位' : 'Reasoning effort'}
        help={locale === 'zh'
          ? '只有推理模型会用到。选「默认」时不发送该参数——不认识它的服务商会拒绝整个请求。'
          : 'Only reasoning models use it. On “default” the field is not sent at all: a provider that does not know it rejects the whole request.'}
      >
        <select
          className="field-input w-full text-[13px]"
          value={draft.reasoningEffort ?? ''}
          aria-label={locale === 'zh' ? '推理档位' : 'Reasoning effort'}
          onChange={(event) => setDraft({
            ...draft,
            reasoningEffort: event.target.value as '' | 'low' | 'medium' | 'high',
          })}
        >
          <option value="">{locale === 'zh' ? '默认（不发送）' : 'Default (not sent)'}</option>
          <option value="low">{locale === 'zh' ? '低' : 'Low'}</option>
          <option value="medium">{locale === 'zh' ? '中' : 'Medium'}</option>
          <option value="high">{locale === 'zh' ? '高' : 'High'}</option>
        </select>
      </Field>

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
            loading={savingKey}
            disabled={!apiKey || !hasBridge()}
            onClick={() => saveKey(apiKey)}
          >
            {t('aiApiKeySave', locale)}
          </Button>
          {keyStored && (
            <Button size="sm" variant="ghost" disabled={savingKey} onClick={() => saveKey('')}>
              {t('clear', locale)}
            </Button>
          )}
        </div>
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {locale === 'zh' ? '取消' : 'Cancel'}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!draft.name.trim() || !draft.baseUrl.trim()}
          onClick={() => onSave({
            ...draft,
            name: draft.name.trim(),
            baseUrl: draft.baseUrl.trim(),
            model: draft.model.trim(),
          })}
        >
          <Check size={12} />
          {locale === 'zh' ? '保存' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

export function AiProviderList({
  providers,
  activeProviderId,
  locale,
  onChange,
  onError,
}: {
  providers: Array<AiProvider & { apiKeyConfigured: boolean }>;
  activeProviderId: string;
  locale: Locale;
  onChange(providers: AiProvider[], activeProviderId: string): void;
  onError(message: string): void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  const bare = (list: Array<AiProvider & { apiKeyConfigured?: boolean }>): AiProvider[] =>
    list.map(({ id, providerId, name, baseUrl, model, reasoningEffort, enabled }) => ({
      id, providerId, name, baseUrl, model, reasoningEffort, enabled,
    }));

  const addProvider = (preset: ProviderPreset) => {
    const provider = createProviderFromPreset(preset, () => crypto.randomUUID());
    onChange([...bare(providers), provider], activeProviderId || provider.id);
    setEditingId(provider.id);
  };

  const updateProvider = (next: AiProvider) => {
    onChange(
      bare(providers).map((provider) => (provider.id === next.id ? next : provider)),
      activeProviderId,
    );
    setEditingId(null);
  };

  const removeProvider = (id: string) => {
    const remaining = bare(providers).filter((provider) => provider.id !== id);
    const nextActive = activeProviderId === id
      ? (remaining.find((provider) => provider.enabled)?.id ?? '')
      : activeProviderId;
    onChange(remaining, nextActive);
    if (editingId === id) setEditingId(null);
  };

  const { local, remote } = groupProviders(providers);

  const renderProvider = (provider: AiProvider & { apiKeyConfigured: boolean }) => {
            const active = provider.id === activeProviderId;
            const editing = editingId === provider.id;
            return (
              <div
                key={provider.id}
                className={clsx(
                  'overflow-hidden rounded-xl border transition-colors',
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border-subtle)] bg-[var(--surface-panel)]',
                )}
              >
                <div className="flex items-center gap-2.5 p-3">
                  <button
                    type="button"
                    onClick={() => onChange(bare(providers), provider.id)}
                    disabled={!provider.enabled}
                    title={locale === 'zh' ? '设为当前使用' : 'Make active'}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50"
                  >
                    <ProviderPlate provider={provider} size="lg" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[14px] font-medium">{provider.name}</span>
                        {active && (
                          <span className="shrink-0 rounded-full bg-[var(--accent)] px-1.5 py-px text-[9px] font-medium text-white">
                            {locale === 'zh' ? '使用中' : 'Active'}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px]">
                        <span className={provider.apiKeyConfigured ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}>
                          {provider.apiKeyConfigured
                            ? (locale === 'zh' ? '已配置密钥' : 'Key configured')
                            : (locale === 'zh' ? '未配置密钥' : 'No key')}
                        </span>
                        <span className="text-[var(--text-muted)]">·</span>
                        <span className="truncate font-mono text-[var(--text-muted)]">
                          {provider.model || (locale === 'zh' ? '未选模型' : 'no model')}
                        </span>
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEditingId(editing ? null : provider.id)}
                    aria-label={locale === 'zh' ? '编辑' : 'Edit'}
                    title={locale === 'zh' ? '编辑' : 'Edit'}
                    className={clsx(
                      'rounded-lg p-1.5 transition-colors',
                      editing
                        ? 'bg-[var(--surface-hover)] text-[var(--accent)]'
                        : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {editing ? <X size={15} /> : <PenLine size={15} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const confirmed = window.confirm(
                        locale === 'zh'
                          ? `删除服务商「${provider.name}」？已保存的密钥也会一并清除。`
                          : `Delete provider “${provider.name}”? Its stored key is cleared too.`,
                      );
                      if (!confirmed) return;
                      if (hasBridge()) {
                        void bridge().setAiApiKey('', provider.id).catch(() => {
                          // The provider is going away; a stale secret is not worth blocking on.
                        });
                      }
                      removeProvider(provider.id);
                    }}
                    aria-label={locale === 'zh' ? '删除' : 'Delete'}
                    title={locale === 'zh' ? '删除' : 'Delete'}
                    className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                  >
                    <Trash2 size={15} />
                  </button>
                  <Toggle
                    checked={provider.enabled}
                    ariaLabel={locale === 'zh' ? '启用' : 'Enabled'}
                    onChange={(enabled) => {
                      const next = bare(providers).map((entry) =>
                        entry.id === provider.id ? { ...entry, enabled } : entry);
                      const nextActive = !enabled && activeProviderId === provider.id
                        ? (next.find((entry) => entry.enabled)?.id ?? '')
                        : activeProviderId;
                      onChange(next, nextActive);
                    }}
                  />
                </div>

                {editing && (
                  <ProviderEditor
                    provider={provider}
                    apiKeyConfigured={provider.apiKeyConfigured}
                    locale={locale}
                    onSave={updateProvider}
                    onCancel={() => setEditingId(null)}
                    onError={onError}
                  />
                )}
              </div>
            );
  };

  return (
    <div className="space-y-2">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-semibold tracking-tight">
            {locale === 'zh' ? '模型服务商' : 'Model providers'}
          </h3>
          <p className="mt-0.5 text-[12.5px] text-[var(--text-muted)]">
            {locale === 'zh'
              ? '按厂商添加，逐个配置地址、模型和密钥；点卡片切换当前使用的服务商。'
              : 'Add by vendor, configure endpoint, model and key per provider; click a card to make it active.'}
          </p>
        </div>
        <AddProviderMenu locale={locale} onAdd={addProvider} />
      </div>

      {providers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-8 text-center">
          <p className="text-[13.5px] text-[var(--text-secondary)]">
            {locale === 'zh' ? '还没有配置任何模型服务商' : 'No model provider configured yet'}
          </p>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">
            {locale === 'zh'
              ? '点右上角「添加服务商」挑一个，或直接用默认的 DeepSeek。'
              : 'Pick one from “Add provider”, or start with the default.'}
          </p>
          {(() => {
            const preset = PROVIDER_PRESETS.find((entry) => entry.id === 'deepseek');
            if (!preset) return null;
            return (
              <Button
                size="sm"
                variant="primary"
                className="mt-3"
                onClick={() => addProvider(preset)}
              >
                <Plus size={13} />
                {locale === 'zh' ? `添加 ${preset.name}` : `Add ${preset.name}`}
              </Button>
            );
          })()}
        </div>
      ) : (
        <div className="space-y-4">
          {([
            ['local', locale === 'zh' ? '本地' : 'Local', local],
            ['remote', locale === 'zh' ? '模型服务商' : 'Model providers', remote],
          ] as const).filter(([, , group]) => group.length > 0).map(([key, heading, group]) => (
            <div key={key} className="space-y-2">
              <p className="text-[12px] font-medium tracking-wide text-[var(--text-muted)]">
                {heading}
              </p>
              <div className="space-y-2">
                {group.map((provider) => renderProvider(provider))}
              </div>
            </div>
          ))}
        </div>
      )}

      {providers.length > 0 && !providers.some((provider) => provider.enabled) && (
        <StatusPill tone="warning">
          {locale === 'zh' ? '所有服务商都已停用' : 'Every provider is disabled'}
        </StatusPill>
      )}
    </div>
  );
}
