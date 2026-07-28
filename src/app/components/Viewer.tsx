import { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { bridge, type PickedFile } from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import { useApp } from '../store.ts';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Eraser,
  FilePenLine,
  Loader2,
  Lock,
  RotateCw,
  Save,
  Stamp,
  Trash2,
  Undo2,
  Wrench,
  ZoomIn,
  ZoomOut,
} from '../icons.ts';
import { clampRect, rectFromDrag, toPdfPoint, type Point, type Size } from '../pdf/geometry.ts';
import { classifyLoadError, type PdfLoadFailure } from '../pdf/loadError.ts';
import { reorderedPages } from '../pdf/pageOrder.ts';
import {
  getFormFields,
  loadPdfDocument,
  renderPageToCanvas,
  type FormFieldBox,
  type PdfDocumentHandle,
} from '../pdf/renderer.ts';
import { Button } from './ui.tsx';

interface ViewerProps {
  file: PickedFile;
  /** Receives the current — possibly edited — document, not the file as opened. */
  onChooseTool(current: PickedFile): void;
  onDirtyChange(dirty: boolean): void;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.2;
const THUMB_SCALE = 0.18;
/** Each undo step holds a full copy of the document, so the stack stays short. */
const HISTORY_LIMIT = 10;

/**
 * PDF viewer with page-level editing.
 *
 * Every edit is a run of an existing `organize.*` tool over the current bytes,
 * whose output becomes the new current bytes. That keeps the PDF engines where
 * they belong (the worker) — the viewer only ever renders and passes bytes
 * around, and never learns how to write a PDF.
 */
export function Viewer({ file, onChooseTool, onDirtyChange }: ViewerProps) {
  const locale = useApp((s) => s.locale);

  const [bytes, setBytes] = useState<Uint8Array>(file.bytes);
  const [history, setHistory] = useState<Uint8Array[]>([]);
  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [failure, setFailure] = useState<PdfLoadFailure | null>(null);
  const [editError, setEditError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragPage, setDragPage] = useState(0);
  /** The accepted password, replayed into every edit so encrypted files stay editable. */
  const [password, setPassword] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [mode, setMode] = useState<'view' | 'redact' | 'stamp' | 'form'>('view');
  const [fields, setFields] = useState<FormFieldBox[]>([]);
  /** Values typed into the overlay, keyed by field name, before they are applied. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** The image being stamped; picked when stamp mode is entered. */
  const [stampImage, setStampImage] = useState<PickedFile | null>(null);
  /** Drag corners in displayed-box pixels; only for drawing the marquee. */
  const [marquee, setMarquee] = useState<{ from: Point; to: Point } | null>(null);
  /** Current page size in PDF points, reported by the last render. */
  const pageSize = useRef<Size>({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;

    loadPdfDocument(bytes, password)
      .then((loaded) => {
        if (cancelled) {
          loaded.destroy();
          return;
        }
        setFailure(null);
        setPageCount(loaded.numPages);
        // After a delete the current page number can be past the new end.
        setPage((current) => Math.min(current, loaded.numPages));
        setDoc(loaded);
      })
      .catch((cause) => {
        if (!cancelled) setFailure(classifyLoadError(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [bytes, password]);

  useEffect(() => () => doc?.destroy(), [doc]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    void renderPageToCanvas(doc, page, canvasRef.current, scale).then((size) => {
      pageSize.current = size;
    });
  }, [doc, page, scale]);

  /**
   * Runs a tool straight over the bridge rather than through the store's
   * `runTool`: these edits fire on every click, and routing them through the
   * job list would add an entry per rotated page.
   */
  const runEdit = useCallback(
    async (toolId: string, params: Record<string, unknown>, extra?: PickedFile) => {
      setBusy(true);
      setEditError('');
      try {
        const result = await bridge().runJob({
          jobId: crypto.randomUUID(),
          toolId,
          files: [
            { name: file.name, bytes, mime: 'application/pdf' },
            ...(extra ? [{ name: extra.name, bytes: extra.bytes, mime: extra.mime }] : []),
          ],
          params: { ...params, password },
        });
        const output = result.files[0];
        if (!output) throw new Error('the tool produced no output');
        setHistory((past) => [...past, bytes].slice(-HISTORY_LIMIT));
        setBytes(output.bytes);
      } catch (cause) {
        setEditError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [bytes, file.name, password],
  );

  const rotatePage = (pageNumber: number) =>
    void runEdit('organize.rotate', { degrees: '90', mode: 'add', pages: String(pageNumber) });

  const deletePage = (pageNumber: number) => {
    if (pageCount <= 1) {
      setEditError(t('viewerLastPage', locale));
      return;
    }
    void runEdit('organize.remove-pages', { pages: String(pageNumber) });
  };

  const movePage = (from: number, to: number) => {
    if (from === to) return;
    void runEdit('organize.reorder', {
      preset: 'custom',
      order: reorderedPages(pageCount, from, to).join(','),
    });
  };

  /** Smaller than this and it was a stray click, not a selection. */
  const MIN_REDACT_PT = 4;

  const redactBox = (from: Point, to: Point, box: Size) => {
    const region = clampRect(
      rectFromDrag(toPdfPoint(from, box, pageSize.current), toPdfPoint(to, box, pageSize.current)),
      pageSize.current,
    );
    if (region.width < MIN_REDACT_PT || region.height < MIN_REDACT_PT) return;

    void runEdit('security.redact', {
      keywords: '',
      pages: 'all',
      caseSensitive: false,
      regions: JSON.stringify([{ page, ...region }]),
    });
  };

  // Field boxes belong to one rendering of one page, so they are reloaded
  // whenever the document or the page changes underneath them.
  useEffect(() => {
    if (!doc || mode !== 'form') return;
    let cancelled = false;
    void getFormFields(doc, page).then((found) => {
      if (cancelled) return;
      setFields(found);
      setDrafts(Object.fromEntries(found.map((field) => [field.name, field.value])));
    });
    return () => {
      cancelled = true;
    };
  }, [doc, page, mode]);

  /**
   * `edit.fill-form` takes one `name=value` per line, so a name carrying an
   * `=` or a newline cannot be addressed unambiguously. Those are skipped
   * rather than silently written to the wrong field.
   */
  const fillable = fields.filter(
    (field) => !field.readOnly && !field.name.includes('=') && !/[\r\n]/.test(field.name),
  );
  const unsafeCount = fields.length - fillable.length;

  const applyForm = () => {
    const changed = fillable.filter((field) => (drafts[field.name] ?? '') !== field.value);
    if (changed.length === 0) return;
    void runEdit('edit.fill-form', {
      mode: 'fill',
      fields: changed
        .map((field) => `${field.name}=${(drafts[field.name] ?? '').replace(/[\r\n]+/g, ' ')}`)
        .join('\n'),
    });
  };

  const stampAt = (at: Point, box: Size) => {
    if (!stampImage) return;
    const point = toPdfPoint(at, box, pageSize.current);
    void runEdit(
      'edit.add-stamp',
      {
        placement: 'point',
        centerX: point.x,
        centerY: point.y,
        widthPercent: 25,
        opacity: 1,
        margin: 36,
        position: 'bottom-right',
        pages: String(page),
      },
      stampImage,
    );
  };

  const enterStampMode = async () => {
    const [image] = await bridge().pickFiles(['.png', '.jpg', '.jpeg'], false);
    if (!image) return;
    setStampImage(image);
    setMode('stamp');
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((past) => past.slice(0, -1));
    setBytes(previous);
  };

  const save = () =>
    void bridge().saveOutputAs({ name: file.name, bytes, mime: 'application/pdf' });

  const edited = history.length > 0;

  // Let the shell warn before it navigates away from unsaved edits.
  useEffect(() => {
    onDirtyChange(edited);
    return () => onDirtyChange(false);
  }, [edited, onDirtyChange]);

  if (failure === 'needs-password' || failure === 'wrong-password') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPassword(passwordDraft);
          }}
          className="surface-panel w-full max-w-sm space-y-3 p-5"
        >
          <div className="flex items-center gap-2">
            <Lock size={15} className="shrink-0 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold">{t('viewerLocked', locale)}</h2>
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {t('viewerLockedHint', locale)}
          </p>
          <input
            type="password"
            autoFocus
            value={passwordDraft}
            onChange={(e) => setPasswordDraft(e.target.value)}
            aria-label={t('viewerPasswordLabel', locale)}
            placeholder={t('viewerPasswordLabel', locale)}
            className="h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 text-[13px] outline-none focus:border-[var(--accent)]"
          />
          {failure === 'wrong-password' && (
            <p className="text-xs text-[var(--danger)]">{t('viewerPasswordWrong', locale)}</p>
          )}
          <Button type="submit" variant="primary" size="sm" disabled={!passwordDraft} className="w-full">
            {t('viewerUnlock', locale)}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside
        className="w-28 shrink-0 space-y-2 overflow-y-auto border-r border-[var(--border-subtle)] p-2"
        title={t('viewerDragHint', locale)}
      >
        {doc &&
          Array.from({ length: pageCount }, (_, i) => i + 1).map((num) => (
            <Thumbnail
              key={`${pageCount}/${num}`}
              doc={doc}
              pageNumber={num}
              active={num === page}
              disabled={busy}
              dragging={dragPage === num}
              locale={locale}
              onClick={() => setPage(num)}
              onRotate={() => rotatePage(num)}
              onDelete={() => deletePage(num)}
              onDragStart={() => setDragPage(num)}
              onDragEnd={() => setDragPage(0)}
              onDropOn={() => {
                if (dragPage) movePage(dragPage, num);
                setDragPage(0);
              }}
            />
          ))}
      </aside>

      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={file.name}>
            {file.name}
          </span>

          {edited && (
            <span className="shrink-0 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent)]">
              {t('viewerEdited', locale)}
            </span>
          )}

          {busy && <Loader2 size={14} className="shrink-0 animate-spin text-[var(--text-muted)]" />}

          {pageCount > 0 && (
            <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
              {t('viewerPageOf', locale)
                .replace('{page}', String(page))
                .replace('{count}', String(pageCount))}
            </span>
          )}

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label={t('viewerZoomOut', locale)}
              disabled={!doc}
              onClick={() => setScale((s) => Math.max(MIN_SCALE, s - SCALE_STEP))}
              className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              <ZoomOut size={15} />
            </button>
            <button
              type="button"
              aria-label={t('viewerZoomIn', locale)}
              disabled={!doc}
              onClick={() => setScale((s) => Math.min(MAX_SCALE, s + SCALE_STEP))}
              className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              <ZoomIn size={15} />
            </button>
            <button
              type="button"
              aria-label={t('viewerUndo', locale)}
              title={t('viewerUndo', locale)}
              disabled={!edited || busy}
              onClick={undo}
              className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              <Undo2 size={15} />
            </button>
          </div>

          <Button
            size="sm"
            variant={mode === 'form' ? 'primary' : 'secondary'}
            disabled={!doc || busy}
            onClick={() => {
              setMarquee(null);
              setStampImage(null);
              setMode((current) => (current === 'form' ? 'view' : 'form'));
            }}
          >
            <FilePenLine size={13} />
            {t(mode === 'form' ? 'viewerFormExit' : 'viewerFormMode', locale)}
          </Button>

          <Button
            size="sm"
            variant={mode === 'stamp' ? 'primary' : 'secondary'}
            disabled={!doc || busy}
            onClick={() => {
              setMarquee(null);
              if (mode === 'stamp') {
                setMode('view');
                setStampImage(null);
              } else {
                void enterStampMode();
              }
            }}
          >
            <Stamp size={13} />
            {t(mode === 'stamp' ? 'viewerStampExit' : 'viewerStampMode', locale)}
          </Button>

          <Button
            size="sm"
            variant={mode === 'redact' ? 'danger' : 'secondary'}
            disabled={!doc || busy}
            onClick={() => {
              setMarquee(null);
              setStampImage(null);
              setMode((current) => (current === 'redact' ? 'view' : 'redact'));
            }}
          >
            <Eraser size={13} />
            {t(mode === 'redact' ? 'viewerRedactExit' : 'viewerRedactMode', locale)}
          </Button>

          <Button size="sm" variant="secondary" disabled={!doc || busy} onClick={save}>
            <Save size={13} />
            {t('viewerSave', locale)}
          </Button>

          <Button
            size="sm"
            variant="primary"
            onClick={() => onChooseTool({ ...file, size: bytes.length, bytes })}
          >
            <Wrench size={13} />
            {t('viewerChooseTool', locale)}
          </Button>
        </header>

        {mode === 'redact' && (
          <div className="flex items-center gap-2 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-2 text-xs text-[var(--danger)]">
            <Eraser size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{t('viewerRedactHint', locale)}</span>
          </div>
        )}

        {mode === 'form' && (
          <div className="flex items-center gap-2 border-b border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-2 text-xs text-[var(--accent)]">
            <FilePenLine size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">
              {fillable.length === 0
                ? t('viewerFormNone', locale)
                : t('viewerFormHint', locale)}
              {unsafeCount > 0 &&
                ` ${t('viewerFormSkipped', locale).replace('{count}', String(unsafeCount))}`}
            </span>
            {fillable.length > 0 && (
              <Button size="sm" variant="primary" disabled={busy} onClick={applyForm}>
                {t('viewerFormApply', locale)}
              </Button>
            )}
          </div>
        )}

        {mode === 'stamp' && stampImage && (
          <div className="flex items-center gap-2 border-b border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-2 text-xs text-[var(--accent)]">
            <Stamp size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">
              {t('viewerStampHint', locale)}（{stampImage.name}）
            </span>
          </div>
        )}

        {password !== '' && (
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-4 py-2 text-xs text-[var(--text-secondary)]">
            <Lock size={13} className="shrink-0" />
            <span className="min-w-0 flex-1">{t('viewerDecryptNotice', locale)}</span>
          </div>
        )}

        {editError && (
          <div className="flex items-center gap-2 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-2 text-xs text-[var(--danger)]">
            <AlertCircle size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {t('viewerEditFailed', locale)} — {editError}
            </span>
          </div>
        )}

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--surface-sunken)] p-6">
          {failure ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--danger)]">
              <AlertCircle size={16} />
              {t('viewerLoadFailed', locale)}
            </div>
          ) : !doc ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
              <Loader2 size={18} className="animate-spin" />
              {t('viewerLoading', locale)}
            </div>
          ) : (
            <div
              className={clsx('relative', mode !== 'view' && !busy && 'cursor-crosshair')}
              onClick={(e) => {
                if (mode !== 'stamp' || busy) return;
                const box = e.currentTarget.getBoundingClientRect();
                stampAt(
                  { x: e.clientX - box.left, y: e.clientY - box.top },
                  { width: box.width, height: box.height },
                );
              }}
              onPointerDown={(e) => {
                if (mode !== 'redact' || busy) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                const box = e.currentTarget.getBoundingClientRect();
                const at = { x: e.clientX - box.left, y: e.clientY - box.top };
                setMarquee({ from: at, to: at });
              }}
              onPointerMove={(e) => {
                if (!marquee) return;
                const box = e.currentTarget.getBoundingClientRect();
                setMarquee((current) =>
                  current
                    ? { ...current, to: { x: e.clientX - box.left, y: e.clientY - box.top } }
                    : null,
                );
              }}
              onPointerUp={(e) => {
                if (!marquee) return;
                const box = e.currentTarget.getBoundingClientRect();
                redactBox(marquee.from, marquee.to, { width: box.width, height: box.height });
                setMarquee(null);
              }}
            >
              <canvas
                ref={canvasRef}
                className={clsx('block rounded shadow-lg', busy && 'opacity-50')}
              />
              {marquee && (
                <div
                  className="pointer-events-none absolute border-2 border-[var(--danger)] bg-[var(--danger)]/30"
                  style={{
                    left: Math.min(marquee.from.x, marquee.to.x),
                    top: Math.min(marquee.from.y, marquee.to.y),
                    width: Math.abs(marquee.from.x - marquee.to.x),
                    height: Math.abs(marquee.from.y - marquee.to.y),
                  }}
                />
              )}

              {mode === 'form' &&
                fillable.map((field) => (
                  <div
                    key={field.name}
                    className="absolute"
                    style={{
                      left: `${field.box.x * 100}%`,
                      top: `${field.box.y * 100}%`,
                      width: `${field.box.width * 100}%`,
                      height: `${field.box.height * 100}%`,
                    }}
                  >
                    {field.checkbox ? (
                      <input
                        type="checkbox"
                        title={field.name}
                        checked={/^(1|true|yes|on|y)$/i.test(drafts[field.name] ?? '')}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [field.name]: e.target.checked ? 'true' : 'false',
                          }))
                        }
                        className="h-full w-full accent-[var(--accent)]"
                      />
                    ) : (
                      <input
                        type="text"
                        title={field.name}
                        value={drafts[field.name] ?? ''}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [field.name]: e.target.value }))
                        }
                        className="h-full w-full rounded-sm border border-[var(--accent)] bg-[var(--accent-soft)] px-1 text-[12px] text-[var(--text-primary)] outline-none focus:bg-[var(--surface-panel)]"
                      />
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>

        {pageCount > 1 && (
          <footer className="flex items-center justify-center gap-3 border-t border-[var(--border-subtle)] py-2">
            <button
              type="button"
              aria-label={t('viewerPrevPage', locale)}
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              aria-label={t('viewerNextPage', locale)}
              disabled={page >= pageCount}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function Thumbnail({
  doc,
  pageNumber,
  active,
  disabled,
  dragging,
  locale,
  onClick,
  onRotate,
  onDelete,
  onDragStart,
  onDragEnd,
  onDropOn,
}: {
  doc: PdfDocumentHandle;
  pageNumber: number;
  active: boolean;
  disabled: boolean;
  dragging: boolean;
  locale: Locale;
  onClick(): void;
  onRotate(): void;
  onDelete(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDropOn(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Large PDFs would otherwise render every page's thumbnail up front;
    // only render once the row is about to scroll into view.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible(true);
      },
      { root: el.closest('aside'), rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    void renderPageToCanvas(doc, pageNumber, canvasRef.current, THUMB_SCALE);
  }, [visible, doc, pageNumber]);

  return (
    <div
      ref={wrapRef}
      draggable={!disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropOn();
      }}
      className={clsx('group relative', dragging && 'opacity-40')}
    >
      <button
        type="button"
        onClick={onClick}
        className={clsx(
          'block w-full overflow-hidden rounded border-2 transition-colors',
          active
            ? 'border-[var(--accent)]'
            : 'border-transparent hover:border-[var(--border-strong)]',
        )}
      >
        <canvas ref={canvasRef} className="w-full bg-white" />
        <span className="block bg-[var(--surface-panel)] py-0.5 text-center font-mono text-[10px] text-[var(--text-muted)]">
          {pageNumber}
        </span>
      </button>

      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          aria-label={t('viewerRotatePage', locale)}
          title={t('viewerRotatePage', locale)}
          disabled={disabled}
          onClick={onRotate}
          className="rounded bg-[var(--surface-panel)] p-1 text-[var(--text-secondary)] shadow transition-colors hover:text-[var(--accent)] disabled:opacity-30"
        >
          <RotateCw size={11} />
        </button>
        <button
          type="button"
          aria-label={t('viewerDeletePage', locale)}
          title={t('viewerDeletePage', locale)}
          disabled={disabled}
          onClick={onDelete}
          className="rounded bg-[var(--surface-panel)] p-1 text-[var(--text-secondary)] shadow transition-colors hover:text-[var(--danger)] disabled:opacity-30"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}
