import { useCallback, useEffect, useState } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { bridge } from '../bridge.ts';
import type { DocumentState } from '../documents.ts';
import { formatBytes, t } from '../i18n.ts';
import { AlertCircle, Check, FileText, Loader2, Save, ToolIcon } from '../icons.ts';
import { useApp } from '../store.ts';
import { classifyOutput } from '../toolApply.ts';
import { ParamForm } from './ParamForm.tsx';
import { Button } from './ui.tsx';

interface ApplyToolPanelProps {
  tool: ToolMeta;
  document: DocumentState;
  onClose(): void;
}

/**
 * Runs a tool against the document on screen, without leaving it.
 *
 * This is the difference between a toolbox and an editor: the document stays
 * where it is, the tool asks for whatever it needs, and the result lands back
 * in the page behind this panel — undoable like any other edit. Tools that
 * cannot produce a document (a conversion, a split) show their output here to
 * be saved instead, and leave the document alone.
 */
export function ApplyToolPanel({ tool, document, onClose }: ApplyToolPanelProps) {
  const locale = useApp((s) => s.locale);
  const applyToolToDocument = useApp((s) => s.applyToolToDocument);

  const [values, setValues] = useState<ParamValues>(() => defaultParams(tool.params));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Set when the tool produced something that is not this document. */
  const [outputs, setOutputs] = useState<ToolOutputFile[] | null>(null);
  const [savedTo, setSavedTo] = useState('');

  const run = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await applyToolToDocument(document.id, tool, values);
      // A single PDF has already replaced the document, so there is nothing
      // left to show — get out of the way and let the user see it.
      if (classifyOutput(result.files).kind === 'document') {
        onClose();
        return;
      }
      setOutputs(result.files);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [applyToolToDocument, document.id, onClose, tool, values]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tool.name[locale]}
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-[var(--border-strong)] bg-[var(--surface-panel)] shadow-2xl"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--border-subtle)] p-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
            <ToolIcon name={tool.icon} size={17} className="text-[var(--accent)]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold">{tool.name[locale]}</h2>
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {tool.description[locale]}
            </p>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <p className="flex items-center gap-2 rounded-lg bg-[var(--surface-sunken)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
            <FileText size={13} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 flex-1 truncate">{document.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
              {formatBytes(document.bytes.length, locale)}
            </span>
          </p>

          {tool.params.length > 0 && (
            <ParamForm
              params={tool.params}
              values={values}
              locale={locale}
              disabled={busy}
              onChange={setValues}
            />
          )}

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[12px] text-[var(--danger)]">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </p>
          )}

          {outputs && (
            <section className="rounded-lg border border-[var(--border-subtle)]">
              <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
                <Check size={13} className="shrink-0 text-[var(--success)]" />
                <h3 className="min-w-0 flex-1 text-[12px] font-semibold">{t('results', locale)}</h3>
                {outputs.length > 0 && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      void bridge()
                        .saveOutputs(outputs)
                        .then((result) => {
                          if (result) setSavedTo(result.directory);
                        });
                    }}
                  >
                    <Save size={12} />
                    {t('saveAll', locale)}
                  </Button>
                )}
              </header>
              <ul className="max-h-40 divide-y divide-[var(--border-subtle)] overflow-y-auto">
                {outputs.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="flex items-center gap-2 px-3 py-2">
                    <FileText size={12} className="shrink-0 text-[var(--text-muted)]" />
                    <span className="min-w-0 flex-1 truncate text-[12px]">{file.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                      {formatBytes(file.bytes.length, locale)}
                    </span>
                  </li>
                ))}
              </ul>
              {savedTo && (
                <p className="border-t border-[var(--border-subtle)] bg-[var(--success-soft)] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
                  {t('savedTo', locale)} {savedTo}
                </p>
              )}
            </section>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-subtle)] p-3">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            {t(outputs ? 'close' : 'cancel', locale)}
          </Button>
          {!outputs && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void run()}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              {t(busy ? 'running' : 'applyToDocument', locale)}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
