import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import {
  bridge,
  hasBridge,
  type AiConfig,
  type AiProvider,
  type ExternalMcpServerState,
  type ExternalMcpStatus,
  type McpClientConfig,
} from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import { AlertCircle, Globe, Plug, ShieldCheck, Sparkles, Terminal, Wrench } from '../icons.ts';
import { AiProviderList } from './AiProviderList.tsx';
import { AiCliAgents } from './AiCliAgents.tsx';
import { AiLocalPrivacy } from './AiLocalPrivacy.tsx';
import { AiImages } from './AiImages.tsx';
import { AiWebSearch } from './AiWebSearch.tsx';
import { validateMcpConfigText } from '../ai/mcpConfigText.ts';
import { useApp } from '../store.ts';
import { Button } from './ui.tsx';
import {
  CopyableCode,
  IconPlate,
  SettingCard,
  SettingRow,
  SettingsSection,
  StatusPill,
  SubTabs,
  Toggle,
  type Tone,
} from './settingsUi.tsx';

type AiTab = 'model' | 'mcp' | 'cli' | 'search' | 'safety';

function externalMcpStateLabel(state: ExternalMcpServerState, locale: Locale): string {
  switch (state) {
    case 'disabled': return t('externalMcpStateDisabled', locale);
    case 'disconnected': return t('externalMcpStateDisconnected', locale);
    case 'connecting': return t('externalMcpStateConnecting', locale);
    case 'connected': return t('externalMcpStateConnected', locale);
    case 'error': return t('externalMcpStateError', locale);
  }
}

/**
 * The three modes, in increasing order of what the assistant may do unasked.
 *
 * Worded for someone who has not read any of this: each one says what happens
 * to a file and what happens on screen, rather than naming a policy.
 */
const PERMISSION_MODES = [
  {
    id: 'observer',
    label: { zh: '只读模式', en: 'Read-only' },
    summary: { zh: '只读，不能动你的文件', en: 'Reads only; never changes a file' },
    detail: {
      zh: 'AI 可以查看文档、回答问题、给建议，但**不能修改任何文件、也不能联网**。它想这么做时会被直接拒绝，不会弹窗问你。适合只想让它帮忙看和分析的时候。',
      en: 'The assistant can read documents, answer questions and suggest things, but cannot change any file or reach the network. Such attempts are refused outright — you are not asked. Good when you only want analysis.',
    },
  },
  {
    id: 'confirm',
    label: { zh: '每次授权', en: 'Ask each time' },
    summary: { zh: '改文件或联网前先问你（推荐）', en: 'Asks before writing or going online (recommended)' },
    detail: {
      zh: 'AI 每次要**修改文件或联网**之前，都会弹出一张卡片告诉你它想做什么，你点「允许」才会执行，点「拒绝」就跳过。只是查看内容不会打扰你。日常用这个。',
      en: 'Before it changes a file or goes online, a card shows what it intends to do; it proceeds only if you allow it. Just reading does not interrupt you. This is the everyday choice.',
    },
  },
  {
    id: 'auto',
    label: { zh: '自动模式', en: 'Automatic' },
    summary: { zh: '直接执行，不再逐个确认', en: 'Runs everything without asking' },
    detail: {
      zh: 'AI 修改文件、联网都**不再问你**，直接做。快，但它可能覆盖你授权目录里的文件、把文件内容发给模型服务商，而你事后才看到。只有运行宏这类会执行任意代码的操作仍然会停下来问你。',
      en: 'It changes files and goes online without asking. Faster, but it may overwrite files in your granted folder and send their contents to the provider before you see it. Only tools that execute arbitrary code, such as running a macro, still stop and ask.',
    },
  },
] as const;

const EXTERNAL_MCP_TONE: Record<ExternalMcpServerState, Tone> = {
  disabled: 'neutral',
  disconnected: 'neutral',
  connecting: 'accent',
  connected: 'success',
  error: 'danger',
};

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function AiSettingsSection({
  apiStatus,
}: {
  apiStatus: { running: boolean; address: string; enabled: boolean };
}) {
  const locale = useApp((s) => s.locale);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);

  const [tab, setTab] = useState<AiTab>('model');
  const [aiConfig, setAiConfig] = useState<AiConfig>({
    providers: [],
    activeProviderId: '',
    maxSteps: settings.ai.maxSteps,
    baseUrl: '',
    model: '',
    apiKeyConfigured: false,
  });
  const [error, setError] = useState('');
  const [mcpConfig, setMcpConfig] = useState<McpClientConfig | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [externalMcpStatus, setExternalMcpStatus] = useState<ExternalMcpStatus>({
    configured: false,
    servers: [],
  });
  const [externalMcpConfig, setExternalMcpConfig] = useState('');
  const [externalMcpBusy, setExternalMcpBusy] = useState(false);

  useEffect(() => {
    if (!hasBridge()) return;
    void bridge().getAiConfig().then(setAiConfig).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [settings.ai]);

  useEffect(() => {
    if (!hasBridge()) return;
    void bridge().getMcpConfig().then(setMcpConfig).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [apiStatus.address, apiStatus.running, settings.api]);

  useEffect(() => {
    if (!hasBridge()) return;
    void bridge().getExternalMcpStatus().then(setExternalMcpStatus).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, []);

  /** Both the MCP toggle and the CLI pane turn the local service on this way. */
  const enableLocalMcp = () => {
    void update({
      api: {
        ...settings.api,
        enabled: true,
        allowLan: false,
        token: settings.api.token || randomToken(),
      },
    });
  };

  const runExternalMcpAction = async (
    action: () => Promise<ExternalMcpStatus>,
    clearInput = false,
  ) => {
    setExternalMcpBusy(true);
    setError('');
    try {
      const status = await action();
      setExternalMcpStatus(status);
      if (clearInput) setExternalMcpConfig('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExternalMcpBusy(false);
    }
  };

  /**
   * The main process owns the provider list — it migrates the pre-list settings
   * shape and knows which keys exist — so the pane renders what it reports and
   * writes changes back through settings.
   */
  const providers = aiConfig.providers;

  const saveProviders = (next: AiProvider[], activeProviderId: string) => {
    void update({ ai: { ...settings.ai, providers: next, activeProviderId } });
    // Reflect the change immediately; the settings round-trip refreshes the
    // per-provider key flags a moment later.
    setAiConfig((current) => ({
      ...current,
      activeProviderId,
      providers: next.map((provider) => ({
        ...provider,
        apiKeyConfigured: current.providers.find((entry) => entry.id === provider.id)?.apiKeyConfigured ?? false,
      })),
    }));
  };
  const externalCheck = validateMcpConfigText(externalMcpConfig);
  const connectedServers = externalMcpStatus.servers.filter((server) => server.state === 'connected');
  const externalToolCount = connectedServers.reduce((total, server) => total + server.toolCount, 0);

  return (
    <div className="space-y-4">
      <SubTabs<AiTab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'model', label: locale === 'zh' ? '模型' : 'Model', icon: Sparkles },
          { id: 'mcp', label: 'MCP', icon: Plug },
          { id: 'cli', label: 'CLI', icon: Terminal },
          { id: 'search', label: locale === 'zh' ? '联网' : 'Online', icon: Globe },
          { id: 'safety', label: locale === 'zh' ? '安全' : 'Safety', icon: ShieldCheck },
        ]}
      />

      {tab === 'model' && (
        <>
          <AiLocalPrivacy
            providers={providers}
            strict={settings.ai.strictLocalPrivacy === true}
            locale={locale}
            onAddProvider={(provider) => saveProviders(
              [...providers.map(({ apiKeyConfigured: _ignored, ...rest }) => rest), provider],
              aiConfig.activeProviderId || provider.id,
            )}
            onSetStrict={(value) => void update({ ai: { ...settings.ai, strictLocalPrivacy: value } })}
          />

          <AiProviderList
            providers={providers}
            activeProviderId={aiConfig.activeProviderId}
            locale={locale}
            onChange={saveProviders}
            onError={setError}
          />

        </>
      )}

      {tab === 'mcp' && (
        <>
          <SettingsSection title={t('mcpSection', locale)} description={t('mcpHelp', locale)}>
            <SettingCard className="space-y-3">
              <div className="flex items-center gap-3">
                <IconPlate icon={Wrench} tone={mcpConfig?.ready ? 'success' : 'neutral'} />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">
                    {locale === 'zh' ? '本机 MCP 服务' : 'Local MCP service'}
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] text-[var(--text-muted)]">
                    {mcpConfig?.ready
                      ? (apiStatus.address || t('apiStatusRunning', locale))
                      : t('mcpNeedsApi', locale)}
                  </div>
                </div>
                <Toggle
                  checked={settings.api.enabled}
                  disabled={!hasBridge()}
                  ariaLabel={t('mcpEnable', locale)}
                  onChange={(enabled) => {
                    if (enabled) enableLocalMcp();
                    else void update({ api: { ...settings.api, enabled: false } });
                  }}
                />
              </div>

              {mcpConfig?.ready ? (
                <CopyableCode
                  label={locale === 'zh' ? '客户端配置' : 'Client configuration'}
                  value={JSON.stringify({ mcpServers: mcpConfig.config.mcpServers }, null, 2)}
                  copyLabel={t('mcpCopyConfig', locale)}
                  copiedLabel={t('mcpCopied', locale)}
                  copied={mcpCopied}
                  onCopy={() => {
                    void navigator.clipboard
                      .writeText(JSON.stringify(mcpConfig.config, null, 2))
                      .then(() => {
                        setMcpCopied(true);
                        window.setTimeout(() => setMcpCopied(false), 2000);
                      });
                  }}
                />
              ) : null}
            </SettingCard>
          </SettingsSection>

          <SettingsSection
            title={t('externalMcpSection', locale)}
            description={t('externalMcpHelp', locale)}
            actions={externalMcpStatus.configured ? (
              <StatusPill tone={connectedServers.length > 0 ? 'success' : 'neutral'}>
                {locale === 'zh'
                  ? `${connectedServers.length} 个已连接 · ${externalToolCount} 个工具`
                  : `${connectedServers.length} connected · ${externalToolCount} tools`}
              </StatusPill>
            ) : undefined}
          >
            <SettingCard className="space-y-3">
              <p className="flex items-start gap-2 rounded-lg bg-[var(--warning-soft)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--warning)]">
                <AlertCircle size={13} className="mt-px shrink-0" />
                <span>{t('externalMcpSecurity', locale)}</span>
              </p>

              <textarea
                className="field-input min-h-40 resize-y font-mono text-[12px] leading-relaxed"
                value={externalMcpConfig}
                spellCheck={false}
                placeholder={'{\n  "mcpServers": {\n    "notion": {\n      "url": "https://example.com/mcp",\n      "headers": { "Authorization": "Bearer …" }\n    }\n  }\n}'}
                onChange={(event) => setExternalMcpConfig(event.target.value)}
              />

              {externalCheck.state === 'invalid' && (
                <p className="flex items-start gap-2 text-[12px] leading-relaxed text-[var(--danger)]">
                  <AlertCircle size={12} className="mt-px shrink-0" />
                  <span>{externalCheck.message[locale]}</span>
                </p>
              )}
              {externalCheck.state === 'valid' && (
                <p className="text-[12px] text-[var(--success)]">
                  {locale === 'zh'
                    ? `格式正确，共 ${externalCheck.serverCount} 个 Server`
                    : `Valid — ${externalCheck.serverCount} server(s)`}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  loading={externalMcpBusy}
                  disabled={!hasBridge() || externalCheck.state !== 'valid'}
                  onClick={() => void runExternalMcpAction(
                    () => bridge().setExternalMcpConfig(externalMcpConfig),
                    true,
                  )}
                >
                  {t('externalMcpSave', locale)}
                </Button>
                {externalMcpStatus.configured && (
                  <>
                    <Button
                      size="sm"
                      disabled={externalMcpBusy}
                      onClick={() => void runExternalMcpAction(() => bridge().refreshExternalMcp())}
                    >
                      {t('externalMcpRefresh', locale)}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={externalMcpBusy}
                      onClick={() => void runExternalMcpAction(
                        () => bridge().clearExternalMcpConfig(),
                        true,
                      )}
                    >
                      {t('externalMcpClear', locale)}
                    </Button>
                  </>
                )}
              </div>

              {externalMcpStatus.configured && externalMcpStatus.servers.length === 0 && (
                <p className="text-[12px] text-[var(--text-muted)]">{t('externalMcpEmpty', locale)}</p>
              )}

              {externalMcpStatus.servers.length > 0 && (
                <div className="space-y-1.5">
                  {externalMcpStatus.servers.map((server) => (
                    <div
                      key={server.id}
                      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <IconPlate
                          icon={server.transport === 'stdio' ? Wrench : Globe}
                          tone={EXTERNAL_MCP_TONE[server.state]}
                          size="sm"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium">{server.id}</div>
                          <div className="text-[11px] text-[var(--text-muted)]">
                            {server.transport}
                            {server.state === 'connected'
                              ? ` · ${server.toolCount} ${locale === 'zh' ? '个工具' : 'tools'}`
                              : ''}
                          </div>
                        </div>
                        <StatusPill
                          tone={EXTERNAL_MCP_TONE[server.state]}
                          pulse={server.state === 'connecting'}
                        >
                          {externalMcpStateLabel(server.state, locale)}
                        </StatusPill>
                      </div>
                      {server.error && (
                        <p className="mt-1.5 break-words text-[10px] text-[var(--danger)]">{server.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </SettingCard>
          </SettingsSection>
        </>
      )}

      {tab === 'search' && (
        <>
          <AiWebSearch
            locale={locale}
            webSearch={settings.ai.webSearch ?? { enabled: false, provider: 'tavily', endpoint: '' }}
            onChange={(next) => void update({ ai: { ...settings.ai, webSearch: next } })}
            onError={setError}
          />
          <AiImages
            locale={locale}
            images={settings.ai.images
              ?? { enabled: true, provider: 'auto', endpoint: '', model: '' }}
            onChange={(next) => void update({ ai: { ...settings.ai, images: next } })}
            onError={setError}
          />
        </>
      )}

      {tab === 'safety' && (
        <>
          <SettingsSection
            title={locale === 'zh' ? '工具与审批' : 'Tools and approval'}
            description={locale === 'zh'
              ? '每次写入文件的工具调用都需要你确认；这里只调整它能连续走多远。'
              : 'Every tool call that writes a file asks first; this only sets how far a turn may go.'}
          >
            <SettingCard divided>
              <div className="py-3">
                <div className="text-[14px] font-medium">
                  {locale === 'zh' ? 'AI 能自己做多少事' : 'How much the assistant may do on its own'}
                </div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                  {locale === 'zh'
                    ? '这条决定 AI 动你的文件之前要不要先问你。'
                    : 'This decides whether the assistant asks before touching your files.'}
                </div>

                <div className="mt-3 space-y-2">
                  {PERMISSION_MODES.map((entry) => {
                    const active = (settings.ai.permissionMode ?? 'confirm') === entry.id;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => void update({
                          ai: { ...settings.ai, permissionMode: entry.id },
                        })}
                        className={clsx(
                          'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                          active
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                            : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
                        )}
                      >
                        <span
                          className={clsx(
                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                            active
                              ? 'border-[var(--accent)] bg-[var(--accent)]'
                              : 'border-[var(--border-strong)]',
                          )}
                        >
                          {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-[14px] font-medium">{entry.label[locale]}</span>
                            <span className="text-[12px] text-[var(--text-muted)]">
                              {entry.summary[locale]}
                            </span>
                          </span>
                          <span className="mt-1 block text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                            {entry.detail[locale].replaceAll('**', '')}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {settings.ai.permissionMode === 'auto' && (
                <div className="py-3">
                  <p className="flex items-start gap-2 rounded-lg bg-[var(--warning-soft)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--warning)]">
                    <AlertCircle size={13} className="mt-px shrink-0" />
                    <span>
                      {locale === 'zh'
                        ? '运行宏这类会执行任意代码的工具，即使在自动放行下也仍然会停下来问你。'
                        : 'Tools that execute arbitrary code, such as running a macro, still stop and ask even on Auto.'}
                    </span>
                  </p>
                </div>
              )}

              <SettingRow label={t('aiMaxSteps', locale)} description={t('aiMaxStepsHelp', locale)}>
                <div className="flex w-44 items-center gap-2">
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={settings.ai.maxSteps ?? 6}
                    aria-label={t('aiMaxSteps', locale)}
                    onChange={(event) => void update({
                      ai: { ...settings.ai, maxSteps: Number(event.target.value) },
                    })}
                    className="flex-1 accent-[var(--accent)]"
                  />
                  <span className="w-6 text-right font-mono text-[13px] font-medium text-[var(--accent)]">
                    {settings.ai.maxSteps ?? 6}
                  </span>
                </div>
              </SettingRow>

              <SettingRow
                label={locale === 'zh' ? '严格本地隐私' : 'Strict local privacy'}
                description={locale === 'zh'
                  ? '只允许回环地址的模型接口；云端服务商和命令行 Agent 的任务会被拒绝。'
                  : 'Allows loopback model endpoints only; turns on a cloud provider or a CLI agent are refused.'}
              >
                <Toggle
                  checked={settings.ai.strictLocalPrivacy === true}
                  disabled={!hasBridge()}
                  ariaLabel={locale === 'zh' ? '严格本地隐私' : 'Strict local privacy'}
                  onChange={(value) => void update({ ai: { ...settings.ai, strictLocalPrivacy: value } })}
                />
              </SettingRow>
            </SettingCard>
          </SettingsSection>

          <SettingsSection title={locale === 'zh' ? '数据去向' : 'Where data goes'}>
            <SettingCard>
              <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                <ShieldCheck size={15} className="mt-px shrink-0 text-[var(--success)]" />
                <span>{t('aiPrivacy', locale)}</span>
              </p>
            </SettingCard>
          </SettingsSection>
        </>
      )}

      {tab === 'cli' && (
        <AiCliAgents
          locale={locale}
          mcpReady={Boolean(mcpConfig?.ready)}
          onEnableMcp={enableLocalMcp}
          onError={setError}
        />
      )}

      {error && (
        <p className="flex items-start gap-2 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[13px] text-[var(--danger)]">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
