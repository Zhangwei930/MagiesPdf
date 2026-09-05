import { useCallback, useEffect, useMemo, useState } from 'react';
import { defaultParams } from '@core/params.ts';
import type { ParamValues, ToolMeta, ToolOutputFile } from '@core/types.ts';
import { bridge, type PickedFile } from '../bridge.ts';
import type { DocumentState } from '../documents.ts';
import { formatBytes, localized, t } from '../i18n.ts';
import {
  AlertCircle,
  Check,
  FileText,
  Loader2,
  Plus,
  Save,
  ToolIcon,
  X,
} from '../icons.ts';
import { useApp } from '../store.ts';
import { classifyOutput, documentTaskParams } from '../toolApply.ts';
import { ParamForm } from './ParamForm.tsx';
import { Button } from './ui.tsx';

/** Report tools (`edit.get-info`, …) return labelled rows in `result.data`. */
function asReportRows(
  data: unknown,
): Array<{ label: { zh: string; en: string }; value: string }> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const ok = data.every(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as { value?: unknown }).value === 'string' &&
      typeof (row as { label?: { zh?: unknown } }).label?.zh === 'string',
  );
  return ok ? (data as Array<{ label: { zh: string; en: string }; value: string }>) : null;
}

const CLOSE_AFTER_KEY = 'magies.pdfTask.closeAfterApply';

function readCloseAfterPreference(): boolean {
  try {
    return window.localStorage.getItem(CLOSE_AFTER_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCloseAfterPreference(value: boolean): void {
  try {
    window.localStorage.setItem(CLOSE_AFTER_KEY, value ? '1' : '0');
  } catch {
    // private mode — keep in-memory only
  }
}

interface ApplyToolPanelProps {
  tool: ToolMeta;
  document: DocumentState;
  onClose(): void;
}

/**
 * WPS-style task pane: docks on the right, compact options, 确定 / 取消.
 *
 * Applying a document edit keeps the pane open so options can be tuned and
 * re-run; export / report results stay visible with save actions.
 */
export function ApplyToolPanel({ tool, document, onClose }: ApplyToolPanelProps) {
  const locale = useApp((s) => s.locale);
  const applyToolToDocument = useApp((s) => s.applyToolToDocument);

  const [values, setValues] = useState<ParamValues>(() => defaultParams(tool.params));
  const [extras, setExtras] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [appliedEdit, setAppliedEdit] = useState(false);
  const [outputs, setOutputs] = useState<ToolOutputFile[] | null>(null);
  const [reportRows, setReportRows] = useState<Array<{
    label: { zh: string; en: string };
    value: string;
  }> | null>(null);
  const [resultSummary, setResultSummary] = useState('');
  const [savedTo, setSavedTo] = useState('');
  const [closeAfterApply, setCloseAfterApply] = useState(readCloseAfterPreference);
  const hasExport = outputs !== null || reportRows !== null;

  const taskParams = useMemo(() => documentTaskParams(tool), [tool]);
  const needsExtras = tool.input.max === null || tool.input.max > 1;
  const minExtras = Math.max(0, tool.input.min - 1);
  const maxExtras =
    tool.input.max === null ? 99 : Math.max(0, tool.input.max - 1);
  const extrasReady = extras.length >= minExtras;
  const canAddMore = extras.length < maxExtras;
  // Document rewrites stay interactive; pure auto-run reports finish after one shot.
  const isDocumentEditTool = tool.output === 'single';

  const accept = useMemo(
    () => tool.input.accept.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)),
    [tool.input.accept],
  );

  const run = useCallback(async () => {
    if (!extrasReady) {
      setError(t('pdfTaskNeedFiles', locale));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await applyToolToDocument(document.id, tool, values, extras);
      setResultSummary(result.summary ? localized(result.summary, locale) : '');
      if (result.changedDocument) {
        setAppliedEdit(true);
        setOutputs(null);
        setReportRows(null);
        setSavedTo('');
        if (closeAfterApply) onClose();
        return;
      }
      // The document is as it was, so whatever the run has to say is the
      // point of it: the field list from "list fields only" used to be
      // thrown away here while the tab was marked unsaved for an edit that
      // never happened.
      const rows = asReportRows(result.data);
      setAppliedEdit(false);
      setReportRows(rows);
      setOutputs(rows ? null : result.files);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    applyToolToDocument,
    closeAfterApply,
    document.id,
    extras,
    extrasReady,
    locale,
    onClose,
    tool,
    values,
  ]);

  // Zero visible options + enough files: run once on open (reports, password-only).
  useEffect(() => {
    if (taskParams.length > 0 || !extrasReady || hasExport || appliedEdit) return;
    const timer = window.setTimeout(() => {
      void run();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !busy) {
        event.preventDefault();
        void run();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose, run]);

  const pickExtras = async () => {
    const picked = await bridge().pickFiles(accept, maxExtras > 1);
    if (picked.length === 0) return;
    setExtras((current) => {
      const room = maxExtras - current.length;
      return [...current, ...picked.slice(0, room)];
    });
  };

  const setCloseAfter = (value: boolean) => {
    setCloseAfterApply(value);
    writeCloseAfterPreference(value);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <button
        type="button"
        aria-label={t('cancel', locale)}
        className="absolute inset-0 bg-black/25"
        disabled={busy}
        onClick={() => {
          if (!busy) onClose();
        }}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={tool.name[locale]}
        className="relative z-10 flex h-full w-full max-w-[min(100vw,22rem)] flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-panel)] shadow-2xl"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
            <ToolIcon name={tool.icon} size={16} className="text-[var(--accent)]" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[13px] font-semibold leading-tight">{tool.name[locale]}</h2>
            <p className="truncate text-[11px] text-[var(--text-muted)]">{document.name}</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
            aria-label={t('close', locale)}
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
          {needsExtras && (
            <section className="space-y-2">
              <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                <span>
                  {t('pdfTaskExtraFiles', locale)}
                  {minExtras > 0 ? ` (≥${minExtras})` : ''}
                </span>
                <span className="font-mono">
                  {extras.length}
                  {tool.input.max !== null ? ` / ${maxExtras}` : ''}
                </span>
              </div>
              <ul className="space-y-1">
                {extras.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex items-center gap-2 rounded-md bg-[var(--surface-sunken)] px-2 py-1.5 text-[12px]"
                  >
                    <FileText size={12} className="shrink-0 text-[var(--text-muted)]" />
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--danger)]"
                      onClick={() => setExtras((current) => current.filter((_, i) => i !== index))}
                      aria-label={t('clear', locale)}
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
              {canAddMore && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void pickExtras()}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--border-strong)] px-2 py-2 text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
                >
                  <Plus size={14} />
                  {t('pdfTaskAddFiles', locale)}
                </button>
              )}
            </section>
          )}

          {taskParams.length > 0 && (
            <ParamForm
              params={taskParams}
              values={values}
              locale={locale}
              disabled={busy}
              density="compact"
              onChange={(next) => {
                setValues(next);
                // Tweaking options after a successful edit means the next run is fresh.
                setAppliedEdit(false);
              }}
            />
          )}

          {taskParams.length === 0 && !needsExtras && busy && (
            <div className="flex flex-col items-center gap-2 py-10 text-[12px] text-[var(--text-muted)]">
              <Loader2 size={22} className="animate-spin text-[var(--accent)]" />
              {t('running', locale)}
            </div>
          )}

          {error && (
            <p className="flex items-start gap-2 rounded-lg bg-[var(--danger-soft)] px-2.5 py-2 text-[12px] text-[var(--danger)]">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </p>
          )}

          {appliedEdit && (
            <div className="space-y-1 rounded-lg bg-[var(--success-soft)] px-2.5 py-2 text-[12px] text-[var(--text-primary)]">
              <p className="flex items-start gap-2">
                <Check size={13} className="mt-0.5 shrink-0 text-[var(--success)]" />
                <span className="min-w-0 flex-1 font-medium">
                  {resultSummary || t('pdfTaskApplied', locale)}
                </span>
              </p>
              <p className="pl-5 text-[11px] text-[var(--text-secondary)]">
                {t('pdfTaskAppliedSaveHint', locale)}
              </p>
              <p className="pl-5 font-mono text-[11px] text-[var(--text-muted)]">
                {t('pdfFileSize', locale)} {formatBytes(document.bytes.length, locale)}
                {document.path ? ` · ${document.path}` : ''}
              </p>
            </div>
          )}

          {hasExport && (
            <section className="overflow-hidden rounded-lg border border-[var(--border-subtle)]">
              <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 py-2">
                <Check size={13} className="shrink-0 text-[var(--success)]" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-[12px] font-semibold">{t('results', locale)}</h3>
                  {resultSummary && (
                    <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                      {resultSummary}
                    </p>
                  )}
                </div>
              </header>
              {reportRows && (
                <dl className="max-h-64 divide-y divide-[var(--border-subtle)] overflow-y-auto">
                  {reportRows.map((row, index) => (
                    <div key={index} className="flex gap-2 px-2.5 py-1.5">
                      <dt className="w-24 shrink-0 text-[11px] text-[var(--text-muted)]">
                        {row.label[locale]}
                      </dt>
                      <dd className="min-w-0 flex-1 break-words text-[12px]">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {outputs && outputs.length > 0 && (
                <ul className="max-h-36 divide-y divide-[var(--border-subtle)] overflow-y-auto">
                  {outputs.map((file, index) => (
                    <li
                      key={`${file.name}-${index}`}
                      className="flex items-center gap-2 px-2.5 py-1.5"
                    >
                      <FileText size={12} className="shrink-0 text-[var(--text-muted)]" />
                      <span className="min-w-0 flex-1 truncate text-[12px]">{file.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
                        {formatBytes(file.bytes.length, locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {savedTo && (
                <p className="border-t border-[var(--border-subtle)] bg-[var(--success-soft)] px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]">
                  {t('savedTo', locale)} {savedTo}
                </p>
              )}
            </section>
          )}
        </div>

        <footer className="flex shrink-0 flex-col gap-2 border-t border-[var(--border-subtle)] px-3 py-2.5">
          {isDocumentEditTool && (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[var(--accent)]"
                checked={closeAfterApply}
                disabled={busy}
                onChange={(event) => setCloseAfter(event.target.checked)}
              />
              {t('pdfTaskCloseAfter', locale)}
            </label>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
              {t(hasExport && !isDocumentEditTool ? 'close' : 'cancel', locale)}
            </Button>
            {outputs && outputs.length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
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
            {(isDocumentEditTool || needsExtras || taskParams.length > 0) && (
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !extrasReady}
                onClick={() => void run()}
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {t(busy ? 'running' : 'pdfTaskOk', locale)}
              </Button>
            )}
          </div>
        </footer>
      </aside>
    </div>
  );
}
