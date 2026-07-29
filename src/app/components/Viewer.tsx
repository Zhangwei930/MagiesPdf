import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { bridge, type PickedFile } from '../bridge.ts';
import { t, type Locale } from '../i18n.ts';
import { useApp } from '../store.ts';
import {
  AlertCircle,
  Eraser,
  FileOutput,
  FilePenLine,
  Loader2,
  Lock,
  Maximize,
  MoveHorizontal,
  Redo2,
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
import {
  PAGE_GAP,
  PAGE_PADDING,
  anchorAt,
  clampScale,
  fitScale,
  offsetForAnchor,
  pageAtOffset,
  pageOffsets,
  scrollTopAfterZoom,
  scrollTopForPage,
  visibleRange,
  zoomStep,
  type ScrollAnchor,
} from '../pdf/layout.ts';
import { classifyLoadError, type PdfLoadFailure } from '../pdf/loadError.ts';
import { currentPlatform, isTypingTarget, matchShortcut } from '../shortcuts.ts';
import { reorderedPages } from '../pdf/pageOrder.ts';
import {
  getFormFields,
  getPageSizes,
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

/** Pages kept rendered on each side of the viewport so scrolling never shows blanks. */
const OVERSCAN = 1;
/** Thumbnails are laid out to a fixed width, so their scale follows the page. */
const THUMB_WIDTH = 88;
/** Each undo step holds a full copy of the document, so the stack stays short. */
const HISTORY_LIMIT = 10;
/** Beyond 2× the extra pixels cost memory without being visible. */
const MAX_DPR = 2;

type ViewMode = 'view' | 'redact' | 'stamp' | 'form';
type FitMode = 'width' | 'page' | null;

/** Shared empty map, so a document with no widgets yet does not remount overlays. */
const NO_FIELDS: ReadonlyMap<number, FormFieldBox[]> = new Map();

function devicePixels(): number {
  return Math.min(MAX_DPR, window.devicePixelRatio || 1);
}

/**
 * PDF viewer with page-level editing.
 *
 * Pages are laid out in one continuous scroll column — the way every reader the
 * user already knows behaves — and only the ones near the viewport are drawn.
 * The layout maths lives in `../pdf/layout.ts`; this component is the wiring.
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
  /** Undone states, newest first — what redo walks back into. */
  const [future, setFuture] = useState<Uint8Array[]>([]);
  /** When the current bytes last reached disk; 0 means they never have. */
  const [savedAt, setSavedAt] = useState(0);
  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  /** Unscaled page sizes, in PDF points — the input to the whole layout. */
  const [sizes, setSizes] = useState<Size[]>([]);
  const [failure, setFailure] = useState<PdfLoadFailure | null>(null);
  const [editError, setEditError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragPage, setDragPage] = useState(0);
  /** The accepted password, replayed into every edit so encrypted files stay editable. */
  const [password, setPassword] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [mode, setMode] = useState<ViewMode>('view');
  /**
   * Form widgets per page, filled in by the pages that have rendered. Tagged
   * with the document they were read from: widget positions belong to one
   * rendering, so an edit has to invalidate them — and comparing here beats an
   * effect that would blank them a render too late.
   */
  const [fieldCache, setFieldCache] = useState<{
    source: PdfDocumentHandle | null;
    byPage: ReadonlyMap<number, FormFieldBox[]>;
  }>({ source: null, byPage: NO_FIELDS });
  /** Values typed into the overlay, keyed by field name, before they are applied. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** The image being stamped; picked when stamp mode is entered. */
  const [stampImage, setStampImage] = useState<PickedFile | null>(null);

  /** The scale in force when no fit mode is; a fit mode overrides it. */
  const [manualScale, setManualScale] = useState(1);
  const [fit, setFit] = useState<FitMode>('width');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [grabbing, setGrabbing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  /** A scroll position to apply once the new scale has been laid out. */
  const pendingScroll = useRef<number | null>(null);
  const scaleRef = useRef(1);
  const scrollFrame = useRef(0);
  /** Where the reader was when an edit started, to be restored once it lands. */
  const restoreAnchor = useRef<ScrollAnchor | null>(null);
  const panFrom = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const pageCount = sizes.length;

  useEffect(() => {
    let cancelled = false;

    loadPdfDocument(bytes, password)
      .then(async (loaded) => {
        const loadedSizes = await getPageSizes(loaded);
        if (cancelled) {
          loaded.destroy();
          return;
        }
        setFailure(null);
        setSizes(loadedSizes);
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

  const fieldsByPage = fieldCache.source === doc ? fieldCache.byPage : NO_FIELDS;

  // ---- layout -------------------------------------------------------------

  /**
   * A fit mode is a standing instruction, not a one-off, so the scale it implies
   * is derived on every render rather than stored — that way a window resize is
   * simply a new answer, with no effect to keep in step. The smallest per-page
   * fit is used so a document of mixed page sizes has *every* page fitting.
   */
  const fittedScale = useMemo(() => {
    if (!fit || sizes.length === 0 || viewport.width === 0) return null;
    return sizes.reduce(
      (smallest, size) => Math.min(smallest, fitScale(size, viewport, fit, PAGE_PADDING)),
      Number.POSITIVE_INFINITY,
    );
  }, [fit, sizes, viewport]);

  const scale = fittedScale ?? manualScale;

  // The wheel handler is a native listener registered once; it reads the scale
  // from here rather than forcing a re-subscribe on every notch of a pinch.
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const offsets = useMemo(() => pageOffsets(sizes, scale, PAGE_GAP), [sizes, scale]);
  const contentTop = scrollTop - PAGE_PADDING;
  const page = pageAtOffset(offsets, contentTop, viewport.height);
  const range = visibleRange(offsets, contentTop, viewport.height, OVERSCAN);
  const columnWidth = useMemo(
    () => sizes.reduce((widest, size) => Math.max(widest, size.width), 0) * scale,
    [sizes, scale],
  );
  const columnHeight = (offsets[offsets.length - 1] ?? 0) + PAGE_PADDING * 2;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () =>
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Applied after layout so the scroll position lands on the new page heights
  // rather than the ones being replaced.
  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = pendingScroll.current;
    pendingScroll.current = null;
  }, [scale]);

  /**
   * An edit rewrites the file, so a page above the reader can change height and
   * carry everything below it along. Putting the anchor back is what keeps a
   * rotate from also scrolling you somewhere you were not.
   */
  useLayoutEffect(() => {
    const anchor = restoreAnchor.current;
    if (!anchor || sizes.length === 0) return;
    restoreAnchor.current = null;
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = offsetForAnchor(offsets, sizes, scale, anchor) + PAGE_PADDING;
    }
  }, [offsets, scale, sizes]);

  const onScroll = useCallback(() => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      setScrollTop(scrollRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  /** Rescales around a fixed point of the viewport, so zooming does not teleport. */
  const zoomTo = useCallback((next: number, anchorY: number) => {
    const element = scrollRef.current;
    const current = scaleRef.current;
    if (element) {
      pendingScroll.current =
        scrollTopAfterZoom(element.scrollTop - PAGE_PADDING, anchorY, current, next) + PAGE_PADDING;
    }
    setFit(null);
    setManualScale(next);
  }, []);

  const zoomBy = useCallback(
    (direction: 1 | -1) => zoomTo(zoomStep(scaleRef.current, direction), viewport.height / 2),
    [viewport.height, zoomTo],
  );

  // ⌘/Ctrl + wheel is also what a trackpad pinch reports. It has to be a native
  // non-passive listener: React's pooled wheel handler cannot preventDefault,
  // and without that the browser zooms the whole window instead.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const anchorY = event.clientY - element.getBoundingClientRect().top;
      zoomTo(clampScale(scaleRef.current * Math.exp(-event.deltaY / 300)), anchorY);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  // Space is the hand tool, the way every PDF reader does it. Held rather than
  // toggled, so it never strands the user in a mode they did not ask for.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    // A window that loses focus mid-drag would otherwise keep the hand tool on.
    const onBlur = () => setSpaceHeld(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  /**
   * Jumps are instant, not animated. Asking for a page and then watching three
   * seconds of scrolling go by is the opposite of responsive — and every reader
   * people already use lands immediately. Reading is what scrolling is for.
   */
  const goToPage = useCallback(
    (target: number) => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = scrollTopForPage(offsets, target) + PAGE_PADDING;
    },
    [offsets],
  );

  // ---- editing ------------------------------------------------------------

  /**
   * Runs a tool straight over the bridge rather than through the store's
   * `runTool`: these edits fire on every click, and routing them through the
   * job list would add an entry per rotated page.
   */
  const runEdit = useCallback(
    async (toolId: string, params: Record<string, unknown>, extra?: PickedFile) => {
      const element = scrollRef.current;
      if (element) {
        restoreAnchor.current = anchorAt(offsets, sizes, scale, element.scrollTop - PAGE_PADDING);
      }
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
        // A fresh edit is a new branch: whatever was undone is not coming back.
        setFuture([]);
        setSavedAt(0);
        setBytes(output.bytes);
      } catch (cause) {
        setEditError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [bytes, file.name, offsets, password, scale, sizes],
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

  const redactBox = useCallback(
    (pageNumber: number, from: Point, to: Point, box: Size) => {
      const pageSize = sizes[pageNumber - 1];
      if (!pageSize) return;
      const region = clampRect(
        rectFromDrag(toPdfPoint(from, box, pageSize), toPdfPoint(to, box, pageSize)),
        pageSize,
      );
      if (region.width < MIN_REDACT_PT || region.height < MIN_REDACT_PT) return;

      void runEdit('security.redact', {
        keywords: '',
        pages: 'all',
        caseSensitive: false,
        regions: JSON.stringify([{ page: pageNumber, ...region }]),
      });
    },
    [runEdit, sizes],
  );

  const stampAt = useCallback(
    (pageNumber: number, at: Point, box: Size) => {
      const pageSize = sizes[pageNumber - 1];
      if (!stampImage || !pageSize) return;
      const point = toPdfPoint(at, box, pageSize);
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
          pages: String(pageNumber),
        },
        stampImage,
      );
    },
    [runEdit, sizes, stampImage],
  );

  const onPageFields = useCallback(
    (source: PdfDocumentHandle, pageNumber: number, found: FormFieldBox[]) => {
      setFieldCache((current) => {
        // A page that finished reading after an edit landed belongs to the old
        // document; start a fresh map rather than mixing the two.
        const byPage =
          current.source === source ? new Map(current.byPage) : new Map<number, FormFieldBox[]>();
        byPage.set(pageNumber, found);
        return { source, byPage };
      });
      setDrafts((current) => {
        const next = { ...current };
        // Only seed names not already being edited, so scrolling a page back
        // into view cannot wipe out what the user just typed into it.
        for (const field of found) {
          if (!(field.name in next)) next[field.name] = field.value;
        }
        return next;
      });
    },
    [],
  );

  const allFields = useMemo(() => [...fieldsByPage.values()].flat(), [fieldsByPage]);

  /**
   * `edit.fill-form` takes one `name=value` per line, so a name carrying an
   * `=` or a newline cannot be addressed unambiguously. Those are skipped
   * rather than silently written to the wrong field.
   */
  const fillable = allFields.filter(
    (field) => !field.readOnly && !field.name.includes('=') && !/[\r\n]/.test(field.name),
  );
  const unsafeCount = allFields.length - fillable.length;

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

  const enterStampMode = async () => {
    const [image] = await bridge().pickFiles(['.png', '.jpg', '.jpeg'], false);
    if (!image) return;
    setStampImage(image);
    setMode('stamp');
  };

  const undo = useCallback(() => {
    setHistory((past) => {
      const previous = past[past.length - 1];
      if (!previous) return past;
      setFuture((ahead) => [bytes, ...ahead].slice(0, HISTORY_LIMIT));
      setBytes(previous);
      return past.slice(0, -1);
    });
  }, [bytes]);

  const redo = useCallback(() => {
    setFuture((ahead) => {
      const next = ahead[0];
      if (!next) return ahead;
      setHistory((past) => [...past, bytes].slice(-HISTORY_LIMIT));
      setBytes(next);
      return ahead.slice(1);
    });
  }, [bytes]);

  /**
   * ⌘S overwrites the file that was opened, the way it does everywhere else.
   * A document with no path behind it — the output of a tool run, handed over
   * in memory — has nowhere to write back to, so it falls through to Save As.
   */
  const save = useCallback(async () => {
    setEditError('');
    try {
      if (file.path === '') {
        const result = await bridge().saveOutputAs({
          name: file.name,
          bytes,
          mime: 'application/pdf',
        });
        if (result) setSavedAt(Date.now());
        return;
      }
      await bridge().writeToPath(file.path, bytes);
      setSavedAt(Date.now());
    } catch (cause) {
      setEditError(
        `${t('viewerSaveFailed', locale)} — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }, [bytes, file.name, file.path, locale]);

  const saveAs = useCallback(async () => {
    const result = await bridge().saveOutputAs({
      name: file.name,
      bytes,
      mime: 'application/pdf',
    });
    if (result) setSavedAt(Date.now());
  }, [bytes, file.name]);

  const edited = history.length > 0;
  /** Cleared by any further edit, so the badge only marks a saved state. */
  const saved = savedAt > 0;

  // Let the shell warn before it navigates away from unsaved edits. Edits that
  // have reached disk are not worth warning about.
  const dirty = edited && !saved;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  /**
   * The document's own shortcuts. The shell owns the ones that are not about a
   * document (⌘O, ⌘W, ⌘K); the two sets do not overlap, so both listeners can
   * sit on the window and ignore what is not theirs.
   */
  useEffect(() => {
    const platform = currentPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      const action = matchShortcut(event, platform, { typing: isTypingTarget(event.target) });

      switch (action) {
        case 'save':
          void save();
          break;
        case 'saveAs':
          void saveAs();
          break;
        case 'undo':
          if (!busy) undo();
          break;
        case 'redo':
          if (!busy) redo();
          break;
        case 'zoomIn':
          zoomBy(1);
          break;
        case 'zoomOut':
          zoomBy(-1);
          break;
        case 'zoomReset':
          zoomTo(1, viewport.height / 2);
          break;
        case 'fitWidth':
          setFit('width');
          break;
        case 'fitPage':
          setFit('page');
          break;
        case 'nextPage':
          goToPage(page + 1);
          break;
        case 'prevPage':
          goToPage(page - 1);
          break;
        case 'firstPage':
          goToPage(1);
          break;
        case 'lastPage':
          goToPage(pageCount);
          break;
        default:
          // Not a document shortcut — leave it for the shell or the browser.
          return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    busy,
    goToPage,
    page,
    pageCount,
    redo,
    save,
    saveAs,
    undo,
    viewport.height,
    zoomBy,
    zoomTo,
  ]);

  const switchMode = (next: ViewMode) => {
    setMode((current) => (current === next ? 'view' : next));
    if (next !== 'stamp') setStampImage(null);
  };

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
          sizes.map((size, index) => (
            <Thumbnail
              key={index + 1}
              doc={doc}
              pageNumber={index + 1}
              size={size}
              active={index + 1 === page}
              disabled={busy}
              dragging={dragPage === index + 1}
              locale={locale}
              onClick={() => goToPage(index + 1)}
              onRotate={() => rotatePage(index + 1)}
              onDelete={() => deletePage(index + 1)}
              onDragStart={() => setDragPage(index + 1)}
              onDragEnd={() => setDragPage(0)}
              onDropOn={() => {
                if (dragPage) movePage(dragPage, index + 1);
                setDragPage(0);
              }}
            />
          ))}
      </aside>

      {/* min-w-0 matters: without it a flex item cannot shrink below its
          content, so the toolbar getting one element wider — the "edited" badge
          appearing after the first edit — would push this column past the
          window, widen the page area, and re-solve fit-width. The whole
          document would visibly re-zoom on the first rotate. */}
      <div className="flex min-h-0 w-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={file.name}>
            {file.name}
          </span>

          {edited && (
            <span
              className={clsx(
                'shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
                saved
                  ? 'bg-[var(--success-soft)] text-[var(--success)]'
                  : 'bg-[var(--accent-soft)] text-[var(--accent)]',
              )}
            >
              {t(saved ? 'viewerSaved' : 'viewerEdited', locale)}
            </span>
          )}

          {busy && <Loader2 size={14} className="shrink-0 animate-spin text-[var(--text-muted)]" />}

          <div className="flex shrink-0 items-center gap-1">
            <ToolbarButton
              label={t('viewerZoomOut', locale)}
              disabled={!doc}
              onClick={() => zoomBy(-1)}
            >
              <ZoomOut size={15} />
            </ToolbarButton>
            <button
              type="button"
              title={t('viewerActualSize', locale)}
              disabled={!doc}
              onClick={() => zoomTo(1, viewport.height / 2)}
              className="min-w-[52px] rounded-md px-1 py-1 font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              {Math.round(scale * 100)}%
            </button>
            <ToolbarButton
              label={t('viewerZoomIn', locale)}
              disabled={!doc}
              onClick={() => zoomBy(1)}
            >
              <ZoomIn size={15} />
            </ToolbarButton>
            <ToolbarButton
              label={t('viewerFitWidth', locale)}
              active={fit === 'width'}
              disabled={!doc}
              onClick={() => setFit('width')}
            >
              <MoveHorizontal size={15} />
            </ToolbarButton>
            <ToolbarButton
              label={t('viewerFitPage', locale)}
              active={fit === 'page'}
              disabled={!doc}
              onClick={() => setFit('page')}
            >
              <Maximize size={15} />
            </ToolbarButton>
            <ToolbarButton
              label={t('viewerUndo', locale)}
              disabled={!edited || busy}
              onClick={undo}
            >
              <Undo2 size={15} />
            </ToolbarButton>
            <ToolbarButton
              label={t('viewerRedo', locale)}
              disabled={future.length === 0 || busy}
              onClick={redo}
            >
              <Redo2 size={15} />
            </ToolbarButton>
          </div>

          {/* The mode switches are icons, the way a toolbar is: their labels
              are long in both languages and would crowd out the filename.
              Whichever mode is on says so in the banner under the toolbar. */}
          <div className="flex shrink-0 items-center gap-1 border-l border-[var(--border-subtle)] pl-2">
            <ToolbarButton
              label={t(mode === 'form' ? 'viewerFormExit' : 'viewerFormMode', locale)}
              active={mode === 'form'}
              disabled={!doc || busy}
              onClick={() => switchMode('form')}
            >
              <FilePenLine size={15} />
            </ToolbarButton>
            <ToolbarButton
              label={t(mode === 'stamp' ? 'viewerStampExit' : 'viewerStampMode', locale)}
              active={mode === 'stamp'}
              disabled={!doc || busy}
              onClick={() => {
                if (mode === 'stamp') switchMode('stamp');
                else void enterStampMode();
              }}
            >
              <Stamp size={15} />
            </ToolbarButton>
            <ToolbarButton
              label={t(mode === 'redact' ? 'viewerRedactExit' : 'viewerRedactMode', locale)}
              active={mode === 'redact'}
              tone="danger"
              disabled={!doc || busy}
              onClick={() => switchMode('redact')}
            >
              <Eraser size={15} />
            </ToolbarButton>
          </div>

          <Button size="sm" variant="secondary" disabled={!doc || busy} onClick={() => void save()}>
            <Save size={13} />
            {t('viewerSave', locale)}
          </Button>

          <ToolbarButton
            label={t('viewerSaveAs', locale)}
            disabled={!doc || busy}
            onClick={() => void saveAs()}
          >
            <FileOutput size={15} />
          </ToolbarButton>

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
          <Banner tone="danger" icon={<Eraser size={13} className="shrink-0" />}>
            <span className="min-w-0 flex-1">{t('viewerRedactHint', locale)}</span>
          </Banner>
        )}

        {mode === 'form' && (
          <Banner tone="accent" icon={<FilePenLine size={13} className="shrink-0" />}>
            <span className="min-w-0 flex-1">
              {fillable.length === 0 ? t('viewerFormNone', locale) : t('viewerFormHint', locale)}
              {unsafeCount > 0 &&
                ` ${t('viewerFormSkipped', locale).replace('{count}', String(unsafeCount))}`}
            </span>
            {fillable.length > 0 && (
              <Button size="sm" variant="primary" disabled={busy} onClick={applyForm}>
                {t('viewerFormApply', locale)}
              </Button>
            )}
          </Banner>
        )}

        {mode === 'stamp' && stampImage && (
          <Banner tone="accent" icon={<Stamp size={13} className="shrink-0" />}>
            <span className="min-w-0 flex-1">
              {t('viewerStampHint', locale)}（{stampImage.name}）
            </span>
          </Banner>
        )}

        {password !== '' && (
          <Banner tone="muted" icon={<Lock size={13} className="shrink-0" />}>
            <span className="min-w-0 flex-1">{t('viewerDecryptNotice', locale)}</span>
          </Banner>
        )}

        {editError && (
          <Banner tone="danger" icon={<AlertCircle size={13} className="shrink-0" />}>
            <span className="min-w-0 flex-1 truncate">
              {t('viewerEditFailed', locale)} — {editError}
            </span>
          </Banner>
        )}

        <div
          ref={scrollRef}
          onScroll={onScroll}
          title={mode === 'view' ? t('viewerPanHint', locale) : undefined}
          onPointerDown={(e) => {
            if (!spaceHeld || !scrollRef.current) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            panFrom.current = {
              x: e.clientX,
              y: e.clientY,
              left: scrollRef.current.scrollLeft,
              top: scrollRef.current.scrollTop,
            };
            setGrabbing(true);
          }}
          onPointerMove={(e) => {
            const from = panFrom.current;
            const element = scrollRef.current;
            if (!from || !element) return;
            element.scrollLeft = from.left - (e.clientX - from.x);
            element.scrollTop = from.top - (e.clientY - from.y);
          }}
          onPointerUp={() => {
            panFrom.current = null;
            setGrabbing(false);
          }}
          className={clsx(
            'min-h-0 flex-1 overflow-auto bg-[var(--surface-sunken)]',
            spaceHeld && (grabbing ? 'cursor-grabbing' : 'cursor-grab'),
          )}
        >
          {failure ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[var(--danger)]">
              <AlertCircle size={16} />
              {t('viewerLoadFailed', locale)}
            </div>
          ) : !doc ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]">
              <Loader2 size={18} className="animate-spin" />
              {t('viewerLoading', locale)}
            </div>
          ) : (
            <div
              className="relative mx-auto"
              style={{ width: columnWidth, minWidth: '100%', height: columnHeight }}
            >
              {sizes.map((size, index) => {
                const pageNumber = index + 1;
                if (pageNumber < range.first || pageNumber > range.last) return null;
                return (
                  <PageView
                    key={pageNumber}
                    doc={doc}
                    pageNumber={pageNumber}
                    size={size}
                    scale={scale}
                    mode={mode}
                    busy={busy}
                    panning={spaceHeld}
                    drafts={drafts}
                    fields={fieldsByPage.get(pageNumber)}
                    top={PAGE_PADDING + (offsets[index] ?? 0)}
                    onFields={onPageFields}
                    onDraftChange={(name, value) =>
                      setDrafts((current) => ({ ...current, [name]: value }))
                    }
                    onRedact={redactBox}
                    onStamp={stampAt}
                  />
                );
              })}
            </div>
          )}
        </div>

        {pageCount > 0 && (
          <footer className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--border-subtle)] py-1.5">
            <input
              type="number"
              min={1}
              max={pageCount}
              value={page}
              aria-label={t('viewerGoToPage', locale)}
              onChange={(e) => {
                const target = Number(e.target.value);
                if (Number.isFinite(target)) goToPage(target);
              }}
              className="w-14 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] px-1.5 py-0.5 text-center font-mono text-[11px] outline-none focus:border-[var(--accent)]"
            />
            <span className="font-mono text-[11px] text-[var(--text-muted)]">/ {pageCount}</span>
          </footer>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  active,
  tone = 'accent',
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  /** What being active looks like — redaction destroys content, so it warns. */
  tone?: 'accent' | 'danger';
  disabled?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'shrink-0 rounded-md p-1.5 transition-colors disabled:opacity-30',
        !active && 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        active && tone === 'accent' && 'bg-[var(--accent-soft)] text-[var(--accent)]',
        active && tone === 'danger' && 'bg-[var(--danger-soft)] text-[var(--danger)]',
      )}
    >
      {children}
    </button>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'danger' | 'accent' | 'muted';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        'flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs',
        tone === 'danger' && 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]',
        tone === 'accent' && 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]',
        tone === 'muted' &&
          'border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
      )}
    >
      {icon}
      {children}
    </div>
  );
}

/**
 * One page in the scroll column: its canvas, and whatever the current mode
 * overlays on it. Absolutely positioned at the offset the layout computed, so
 * the column's height never depends on what has finished rendering.
 */
function PageView({
  doc,
  pageNumber,
  size,
  scale,
  mode,
  busy,
  panning,
  drafts,
  fields,
  top,
  onFields,
  onDraftChange,
  onRedact,
  onStamp,
}: {
  doc: PdfDocumentHandle;
  pageNumber: number;
  size: Size;
  scale: number;
  mode: ViewMode;
  busy: boolean;
  panning: boolean;
  drafts: Record<string, string>;
  fields: FormFieldBox[] | undefined;
  top: number;
  onFields(source: PdfDocumentHandle, pageNumber: number, fields: FormFieldBox[]): void;
  onDraftChange(name: string, value: string): void;
  onRedact(pageNumber: number, from: Point, to: Point, box: Size): void;
  onStamp(pageNumber: number, at: Point, box: Size): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [marquee, setMarquee] = useState<{ from: Point; to: Point } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let stale = false;
    void renderPageToCanvas(doc, pageNumber, canvas, scale, devicePixels(), () => stale).catch(
      () => {
        // A page that will not draw leaves the previous image up; the load
        // failure the document itself reports is the one worth surfacing.
      },
    );
    return () => {
      stale = true;
    };
  }, [doc, pageNumber, scale]);

  useEffect(() => {
    if (mode !== 'form' || fields) return;
    let cancelled = false;
    void getFormFields(doc, pageNumber).then((found) => {
      if (!cancelled) onFields(doc, pageNumber, found);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, mode, fields, onFields]);

  const fillable = (fields ?? []).filter(
    (field) => !field.readOnly && !field.name.includes('=') && !/[\r\n]/.test(field.name),
  );
  const interactive = mode !== 'view' && !busy && !panning;

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2"
      style={{ top, width: size.width * scale, height: size.height * scale }}
    >
      <div
        className={clsx('relative h-full w-full', interactive && 'cursor-crosshair')}
        onClick={(e) => {
          if (mode !== 'stamp' || !interactive) return;
          const box = e.currentTarget.getBoundingClientRect();
          onStamp(
            pageNumber,
            { x: e.clientX - box.left, y: e.clientY - box.top },
            { width: box.width, height: box.height },
          );
        }}
        onPointerDown={(e) => {
          if (mode !== 'redact' || !interactive) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const box = e.currentTarget.getBoundingClientRect();
          const at = { x: e.clientX - box.left, y: e.clientY - box.top };
          setMarquee({ from: at, to: at });
        }}
        onPointerMove={(e) => {
          if (!marquee) return;
          const box = e.currentTarget.getBoundingClientRect();
          const to = { x: e.clientX - box.left, y: e.clientY - box.top };
          setMarquee((current) => (current ? { ...current, to } : null));
        }}
        onPointerUp={(e) => {
          if (!marquee) return;
          const box = e.currentTarget.getBoundingClientRect();
          onRedact(pageNumber, marquee.from, marquee.to, {
            width: box.width,
            height: box.height,
          });
          setMarquee(null);
        }}
      >
        <canvas ref={canvasRef} className="block bg-white shadow-lg" />

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
                  onChange={(e) => onDraftChange(field.name, e.target.checked ? 'true' : 'false')}
                  className="h-full w-full accent-[var(--accent)]"
                />
              ) : (
                <input
                  type="text"
                  title={field.name}
                  value={drafts[field.name] ?? ''}
                  onChange={(e) => onDraftChange(field.name, e.target.value)}
                  className="h-full w-full rounded-sm border border-[var(--accent)] bg-[var(--accent-soft)] px-1 text-[12px] text-[var(--text-primary)] outline-none focus:bg-[var(--surface-panel)]"
                />
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

function Thumbnail({
  doc,
  pageNumber,
  size,
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
  size: Size;
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

  // Every thumbnail is laid out to the same width, whatever the page's shape.
  const scale = size.width > 0 ? THUMB_WIDTH / size.width : 0.18;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    let stale = false;
    void renderPageToCanvas(doc, pageNumber, canvas, scale, devicePixels(), () => stale).catch(
      () => {
        // Same as the main page: keep whatever was already drawn.
      },
    );
    return () => {
      stale = true;
    };
  }, [visible, doc, pageNumber, scale]);

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
        <canvas ref={canvasRef} className="mx-auto block bg-white" />
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
