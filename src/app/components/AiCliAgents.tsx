import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { bridge, hasBridge, type CliAgentStatus } from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import { AlertCircle, Check, RefreshCw } from '../icons.ts';
import { Button } from './ui.tsx';
import { CopyableCode, SettingCard, StatusPill } from './settingsUi.tsx';
import { VendorMark } from './AiProviderList.tsx';

/**
 * Coding-agent CLIs installed on this machine, and a one-click way to let them
 * call Magies Office tools over the local MCP server.
 *
 * "Install" edits a file another program owns, so the pane is explicit about
 * which file it will touch and only offers the button for agents whose format
 * the main process can round-trip. The rest get a snippet to paste — see
 * `electron/ai/cliAgents.cjs` for why that line is drawn where it is.
 */
export function AiCliAgents({
  locale,
  mcpReady,
  onEnableMcp,
  onError,
}: {
  locale: Locale;
  mcpReady: boolean;
  /** Turns on the local MCP service, which every install here depends on. */
  onEnableMcp(): void;
  onError(message: string): void;
}) {
  const [agents, setAgents] = useState<CliAgentStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [snippet, setSnippet] = useState<
    { agentId: string; text: string; error: string } | null
  >(null);
  const [copied, setCopied] = useState(false);
  const [installed, setInstalled] = useState<string[]>([]);

  const refresh = useCallback(() => {
    if (!hasBridge()) return;
    setLoading(true);
    void bridge()
      .getCliAgents()
      .then(setAgents)
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, [onError]);

  // Scanning the filesystem is the external system here; the state it produces
  // lands in the promise callback, not synchronously in the effect body.
  useEffect(() => {
    if (!hasBridge()) return;
    let cancelled = false;
    void bridge()
      .getCliAgents()
      .then((found) => {
        if (!cancelled) setAgents(found);
      })
      .catch((cause: unknown) => {
        if (!cancelled) onError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const install = (agent: CliAgentStatus) => {
    setBusyId(agent.id);
    onError('');
    setSnippet(null);
    void bridge()
      .installCliMcp(agent.id)
      .then((result) => {
        if (result.ok) {
          setInstalled((current) => [...current, agent.name]);
          refresh();
        } else {
          setSnippet({ agentId: agent.id, text: result.snippet, error: result.error });
        }
      })
      .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusyId(''));
  };

  return (
    <div className="space-y-2">
      <div className="flex min-h-8 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-semibold tracking-tight">
            {locale === 'zh' ? '命令行 Agent' : 'Coding-agent CLIs'}
          </h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            {locale === 'zh'
              ? '把本机 MCP 服务加进这些 CLI 的配置，之后在终端里就能让它们调用 Magies Office 的 PDF / Office 工具。'
              : 'Add the local MCP server to these CLIs so they can call Magies Office tools from your terminal.'}
          </p>
        </div>
        <Button size="sm" loading={loading} onClick={refresh} disabled={!hasBridge()}>
          <RefreshCw size={13} />
          {locale === 'zh' ? '重新检测' : 'Rescan'}
        </Button>
      </div>

      {!mcpReady && (
        <div className="flex items-center gap-3 rounded-lg bg-[var(--warning-soft)] px-2.5 py-2">
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--warning)]">
            {locale === 'zh'
              ? '接入要把带访问令牌的配置写进 CLI，所以得先启用本机 MCP 服务。'
              : 'Connecting writes a token-bearing configuration into the CLI, so the local MCP service has to be on first.'}
          </p>
          <Button size="sm" variant="primary" disabled={!hasBridge()} onClick={onEnableMcp}>
            {locale === 'zh' ? '启用' : 'Turn on'}
          </Button>
        </div>
      )}

      <SettingCard divided>
        {agents.map((agent) => {
          const justInstalled = installed.includes(agent.id);
          const configured = agent.mcpInstalled || justInstalled;
          return (
            <div key={agent.id} className="flex items-center gap-3 py-3">
              <VendorMark
                iconId={`cli:${agent.id}`}
                fallback={agent.name.charAt(0)}
                tone={agent.installed ? (configured ? 'emerald' : 'indigo') : 'slate'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[14px] font-medium">{agent.name}</span>
                  {agent.version && (
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                      {agent.version}
                    </span>
                  )}
                </div>
                <div
                  className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--text-muted)]"
                  title={agent.installed ? agent.path : agent.configPath}
                >
                  {agent.installed ? agent.path : `${agent.command} — ${locale === 'zh' ? '未检测到' : 'not found'}`}
                </div>
              </div>

              {agent.installed && agent.runnable && (
                <span
                  className="shrink-0 text-[10.5px] leading-snug text-[var(--text-muted)]"
                  title={locale === 'zh'
                    ? '命令行只负责规划；写文件/改 Office 只能走 magies-office。不会开启 shell 级跳过权限。'
                    : 'CLI plans only; Office edits go through magies-office. Shell-level permission bypass is never enabled.'}
                >
                  {locale === 'zh' ? '仅 Magies 工具' : 'Magies tools only'}
                </span>
              )}

              {configured ? (
                <StatusPill tone="success">
                  {locale === 'zh' ? '已接入' : 'Connected'}
                </StatusPill>
              ) : agent.installed && agent.format === 'none' ? (
                <span
                  className="shrink-0 text-[12px] text-[var(--text-muted)]"
                  title={locale === 'zh'
                    ? '它没有可写入的 MCP 配置，本应用不会去猜它的格式。仍可在助手面板里选它执行任务。'
                    : 'It exposes no MCP configuration and this app will not guess at one. It can still run turns from the assistant panel.'}
                >
                  {locale === 'zh' ? '不支持接入' : 'No MCP config'}
                </span>
              ) : agent.installed ? (
                <Button
                  size="sm"
                  variant={agent.format === 'json' ? 'primary' : 'secondary'}
                  loading={busyId === agent.id}
                  disabled={!mcpReady || !hasBridge()}
                  title={mcpReady
                    ? agent.configPath
                    : (locale === 'zh' ? '需先启用本机 MCP 服务' : 'Enable the local MCP service first')}
                  onClick={() => install(agent)}
                >
                  {agent.format === 'json'
                    ? (locale === 'zh' ? '一键接入' : 'Connect')
                    : (locale === 'zh' ? '获取配置' : 'Get snippet')}
                </Button>
              ) : (
                <span className="shrink-0 text-[12px] text-[var(--text-muted)]">
                  {locale === 'zh' ? '未安装' : 'Not installed'}
                </span>
              )}
            </div>
          );
        })}

        {agents.length === 0 && !loading && (
          <p className="py-6 text-center text-[12.5px] text-[var(--text-muted)]">
            {hasBridge()
              ? (locale === 'zh' ? '没有检测到命令行 Agent' : 'No coding-agent CLI found')
              : t('bridgeMissing', locale)}
          </p>
        )}
      </SettingCard>

      {snippet && (
        <SettingCard className="space-y-2">
          <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-[var(--danger)]">
            <AlertCircle size={13} className="mt-px shrink-0" />
            <span>
              {locale === 'zh'
                ? `${agents.find((agent) => agent.id === snippet.agentId)?.name ?? ''} 自己的接入命令没有成功${snippet.error ? '：' : '。'}`
                : `${agents.find((agent) => agent.id === snippet.agentId)?.name ?? ''} could not add it itself${snippet.error ? ': ' : '.'}`}
              {snippet.error && <span className="font-mono">{snippet.error}</span>}
            </span>
          </p>
          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            {locale === 'zh' ? '它的配置文件本应用不会去改写，你可以把下面这段自己贴进 ' : 'Its config file is never rewritten by this app; paste the block below into '}
            <code className="font-mono text-[10.5px]">
              {agents.find((agent) => agent.id === snippet.agentId)?.configPath}
            </code>
            {locale === 'zh' ? ' 。' : '.'}
          </p>
          <CopyableCode
            value={snippet.text}
            copyLabel={t('mcpCopyConfig', locale)}
            copiedLabel={t('mcpCopied', locale)}
            copied={copied}
            label={locale === 'zh' ? 'config.toml 片段' : 'config.toml snippet'}
            onCopy={() => {
              void navigator.clipboard.writeText(snippet.text).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              });
            }}
          />
        </SettingCard>
      )}

      {installed.length > 0 && (
        <p className={clsx('flex items-start gap-1.5 text-[12px]', 'text-[var(--success)]')}>
          <Check size={12} className="mt-0.5 shrink-0" />
          <span>
            {locale === 'zh'
              ? `已接入 ${installed.join('、')}，重启对应的 CLI 后生效。`
              : `Connected ${installed.join(', ')}. Restart those CLIs to pick it up.`}
          </span>
        </p>
      )}
    </div>
  );
}
