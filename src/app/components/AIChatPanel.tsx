import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolOutputFile } from '@core/types.ts';
import type { DocumentState } from '../documents.ts';
import {
  bridge,
  hasBridge,
  type AiConfig,
  type PickedFile,
} from '../bridge.ts';
import { formatBytes, localized, t, type Locale } from '../i18n.ts';
import { AlertCircle, Bot, FileText, Loader2, Save, Send, Square, X } from '../icons.ts';
import {
  applyAiEvent,
  createTurnState,
  type AiChatMessage,
  type AiTurnState,
  type AiToolActivity,
} from '../ai/chatState.ts';
import { Button, ProgressBar } from './ui.tsx';

interface AIChatPanelProps {
  open: boolean;
  locale: Locale;
  activeDocument: DocumentState | null;
  onClose(): void;
  onOpenSettings(): void;
  onPreviewFile(file: PickedFile): void;
}

function toolLabel(tool: AiToolActivity, locale: Locale): string {
  return localized(tool.toolName, locale) || tool.toolId;
}

function ArtifactActions({
  files,
  locale,
  onPreviewFile,
}: {
  files: ToolOutputFile[];
  locale: Locale;
  onPreviewFile(file: PickedFile): void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {files.map((file, index) => (
        <div
          key={`${file.name}-${index}`}
          className="flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2"
        >
          <FileText size={15} className="shrink-0 text-[var(--accent)]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium">{file.name}</p>
            <p className="text-[10px] text-[var(--text-muted)]">{formatBytes(file.bytes.length, locale)}</p>
          </div>
          {file.mime === 'application/pdf' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={() => onPreviewFile({
                name: file.name,
                path: '',
                size: file.bytes.length,
                mime: file.mime,
                bytes: file.bytes,
              })}
            >
              {t('aiOpenFile', locale)}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            aria-label={t('aiSaveFile', locale)}
            onClick={() => void bridge().saveOutputAs(file)}
          >
            <Save size={13} />
          </Button>
        </div>
      ))}
      {files.length > 1 && (
        <Button
          size="sm"
          className="w-full"
          onClick={() => void bridge().saveOutputs(files)}
        >
          {t('saveAll', locale)}
        </Button>
      )}
    </div>
  );
}

function ToolActivities({ tools, locale }: { tools: AiToolActivity[]; locale: Locale }) {
  if (tools.length === 0) return null;
  return (
    <div className="mb-2 space-y-1.5">
      {tools.map((tool) => (
        <div
          key={tool.callId}
          className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 py-2"
        >
          <div className="flex items-center gap-2 text-[11px]">
            {tool.status === 'running' ? (
              <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
            ) : tool.status === 'error' ? (
              <AlertCircle size={12} className="text-[var(--danger)]" />
            ) : (
              <span className="text-[var(--success)]">✓</span>
            )}
            <span className="truncate font-medium">{toolLabel(tool, locale)}</span>
          </div>
          {tool.status === 'running' && <div className="mt-1.5"><ProgressBar value={tool.fraction} /></div>}
          {tool.error && <p className="mt-1 text-[10px] text-[var(--danger)]">{tool.error}</p>}
        </div>
      ))}
    </div>
  );
}

export function AIChatPanel({
  open,
  locale,
  activeDocument,
  onClose,
  onOpenSettings,
  onPreviewFile,
}: AIChatPanelProps) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [turn, setTurn] = useState<AiTurnState | null>(null);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [error, setError] = useState('');
  const turnRef = useRef<AiTurnState | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const updateTurn = useCallback((change: (current: AiTurnState) => AiTurnState) => {
    setTurn((current) => {
      if (!current) return current;
      const next = change(current);
      turnRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!hasBridge()) return;
    return bridge().onAiEvent((event) => {
      updateTurn((current) => applyAiEvent(current, event));
    });
  }, [updateTurn]);

  useEffect(() => {
    if (!open || !hasBridge()) return;
    void bridge().getAiConfig().then(setConfig).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, turn?.assistantText, turn?.tools.length, turn?.approvals.length]);

  const send = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || turn || !hasBridge()) return;

    setError('');
    try {
      const currentConfig = await bridge().getAiConfig();
      setConfig(currentConfig);
      if (!currentConfig.model.trim()) {
        setError(t('aiNoModel', locale));
        return;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    const requestId = crypto.randomUUID();
    const currentTurn = createTurnState(requestId);
    turnRef.current = currentTurn;
    setTurn(currentTurn);
    setDraft('');
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: prompt },
    ]);

    try {
      const result = await bridge().runAiTurn({
        requestId,
        prompt,
        history,
        locale,
        files: activeDocument
          ? [{
              id: 'file-1',
              name: activeDocument.name,
              mime: 'application/pdf',
              bytes: activeDocument.bytes,
              password: activeDocument.password,
            }]
          : [],
      });
      const completed = turnRef.current;
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.message || completed?.assistantText || '',
          tools: completed?.tools,
          artifacts: result.files,
        },
      ]);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'assistant', content: message, error: true },
      ]);
    } finally {
      turnRef.current = null;
      setTurn(null);
    }
  }, [activeDocument, draft, locale, messages, turn]);

  return (
    <aside
      className={`${open ? 'flex' : 'hidden'} h-full w-[390px] shrink-0 flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-panel)]`}
      aria-label={t('aiAssistant', locale)}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
        <Bot size={16} className="text-[var(--accent)]" />
        <h2 className="flex-1 text-[13px] font-semibold">{t('aiAssistant', locale)}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
          aria-label={t('close', locale)}
        >
          <X size={15} />
        </button>
      </div>

      {activeDocument && (
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-[var(--accent)]">
          <FileText size={13} />
          <span className="truncate">{activeDocument.name}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {messages.length === 0 && !turn && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center">
            <Bot size={28} strokeWidth={1.5} className="mb-3 text-[var(--accent)]" />
            <p className="text-sm font-medium">{t('aiEmpty', locale)}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-muted)]">
              {t('aiEmptyHint', locale)}
            </p>
            {!config?.model && (
              <Button size="sm" className="mt-4" onClick={onOpenSettings}>
                {t('aiOpenSettings', locale)}
              </Button>
            )}
          </div>
        )}

        <div className="space-y-3">
          {messages.map((message) => (
            <div
              key={message.id}
              className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={message.role === 'user'
                  ? 'max-w-[88%] rounded-xl rounded-br-sm bg-[var(--accent)] px-3 py-2 text-[13px] whitespace-pre-wrap text-white'
                  : `max-w-full rounded-xl rounded-bl-sm border px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap ${message.error ? 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]' : 'border-[var(--border-subtle)] bg-[var(--surface-raised)]'}`}
              >
                {message.tools && <ToolActivities tools={message.tools} locale={locale} />}
                {message.content}
                {message.artifacts && (
                  <ArtifactActions files={message.artifacts} locale={locale} onPreviewFile={onPreviewFile} />
                )}
              </div>
            </div>
          ))}

          {turn && (
            <div className="rounded-xl rounded-bl-sm border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-[13px]">
              <ToolActivities tools={turn.tools} locale={locale} />
              {turn.assistantText ? (
                <p className="leading-relaxed whitespace-pre-wrap">{turn.assistantText}</p>
              ) : turn.approvals.length === 0 ? (
                <div className="flex items-center gap-2 text-[var(--text-muted)]">
                  <Loader2 size={13} className="animate-spin" />
                  {t('aiThinking', locale)}
                </div>
              ) : null}
              {turn.approvals.map((approval) => (
                <div key={approval.approvalId} className="mt-2 rounded-lg border border-[var(--accent)] bg-[var(--accent-soft)] p-2.5">
                  <p className="text-[12px] font-medium">{t('aiApprovalTitle', locale)}</p>
                          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                            {localized(approval.toolName, locale) || approval.toolId}
                            {approval.inputFileNames.length > 0 ? ` · ${approval.inputFileNames.join(', ')}` : ''}
                          </p>
                          {approval.details && (
                            <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-[var(--surface-sunken)] p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all">
                              {approval.details}
                            </pre>
                          )}
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void bridge().respondAiApproval(turn.requestId, approval.approvalId, false)}
                    >
                      {t('aiDeny', locale)}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void bridge().respondAiApproval(turn.requestId, approval.approvalId, true)}
                    >
                      {t('aiApprove', locale)}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {error && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg bg-[var(--danger-soft)] px-2.5 py-2 text-[11px] text-[var(--danger)]">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={onOpenSettings} className="font-medium underline">
            {t('aiOpenSettings', locale)}
          </button>
        </div>
      )}

      <div className="shrink-0 border-t border-[var(--border-subtle)] p-3">
        <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-2 focus-within:border-[var(--accent)]">
          <textarea
            value={draft}
            rows={3}
            disabled={Boolean(turn)}
            placeholder={t('aiPlaceholder', locale)}
            className="w-full resize-none bg-transparent px-1 text-[13px] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-60"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="max-w-[240px] truncate text-[10px] text-[var(--text-muted)]">
              {config?.model || t('aiNoModelShort', locale)}
            </span>
            {turn ? (
              <Button
                size="sm"
                variant="danger"
                className="h-7 px-2"
                onClick={() => void bridge().cancelAiTurn(turn.requestId)}
              >
                <Square size={11} fill="currentColor" />
                {t('aiStop', locale)}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                className="h-7 px-2"
                disabled={!draft.trim() || !hasBridge()}
                onClick={() => void send()}
              >
                <Send size={12} />
                {t('aiSend', locale)}
              </Button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
