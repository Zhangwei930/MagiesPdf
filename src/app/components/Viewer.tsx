import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  PenLine,
  RotateCw,
  Search,
  Stamp,
  Trash2,
  X,
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
import { bumpEpochs, pagesFrom, type Invalidation } from '../pdf/invalidation.ts';
import { findInItems, nextMatchIndex, type ItemRange } from '../pdf/textSearch.ts';
import { canRedo, canUndo, type DocumentState } from '../documents.ts';
import { currentPlatform, isTypingTarget, matchShortcut } from '../shortcuts.ts';
import { reorderedPages } from '../pdf/pageOrder.ts';
import {
  getFormFields,
  getPageSizes,
  getPageTextItems,
  loadPdfDocument,
  renderPageToCanvas,
  renderTextLayer,
  type FormFieldBox,
  type PdfDocumentHandle,
} from '../pdf/renderer.ts';
import { Button } from './ui.tsx';
import { PdfChrome, type PdfPageLayout, type PdfPointerTool } from './PdfChrome.tsx';
import { PdfFileMenu } from './PdfFileMenu.tsx';
import { PdfQuickConvert } from './PdfQuickConvert.tsx';
import { PdfStatusBar } from './PdfStatusBar.tsx';

interface ViewerProps {
  /** Which open document to show. Its state lives in the store, not here. */
  document: DocumentState;
  /** Opens the tool picker for the document as it stands. */
  onChooseTool(): void;
  /** Runs a tool id against this document (WPS-style quick convert). */
  onRunTool?(toolId: string): void;
  /** System open dialog / open recent path (File menu). */
  onOpenDocument?(): void;
  onOpenRecent?(path: string): void;
  onOpenSettings?(): void;
}

/** Pages kept rendered on each side of the viewport so scrolling never shows blanks. */
const OVERSCAN = 1;
/** Thumbnails are laid out to a fixed width, so their scale follows the page. */
const THUMB_WIDTH = 88;
/** Beyond 2× the extra pixels cost memory without being visible. */
const MAX_DPR = 2;

type ViewMode = 'view' | 'text' | 'redact' | 'stamp' | 'form';
type FitMode = 'width' | 'page' | null;

/** Shared empty map, so a document with no widgets yet does not remount overlays. */
const NO_FIELDS: ReadonlyMap<number, FormFieldBox[]> = new Map();
/** Shared empty list, so a page with no hits does not get a new array each render. */
const NO_HITS: readonly number[] = [];

/** A search hit, located by page as well as by the runs it covers. */
interface DocumentMatch extends ItemRange {
  page: number;
}

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
 *
 * The bytes, the undo history and the save state belong to the store, so that a
 * tool applied from the toolbar lands in the same history as a rotate, and so
 * switching tabs does not throw the document away.
 */
export function Viewer({
  document: openDocument,
  onChooseTool,
  onRunTool,
  onOpenDocument,
  onOpenRecent,
  onOpenSettings,
}: ViewerProps) {
  const locale = useApp((s) => s.locale);
  const [thumbsOpen, setThumbsOpen] = useState(true);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  /** WPS 手型 / 选择 — hand pans without holding Space. */
  const [pointerTool, setPointerTool] = useState<PdfPointerTool>('select');
  /** Continuous scroll column vs one page at a time. */
  const [pageLayout, setPageLayout] = useState<PdfPageLayout>('continuous');
  const editDocument = useApp((s) => s.editDocument);
  const undoDocument = useApp((s) => s.undoDocument);
  const redoDocument = useApp((s) => s.redoDocument);
  const setDocumentPassword = useApp((s) => s.setDocumentPassword);
  const saveDocument = useApp((s) => s.saveDocument);
  const saveDocumentAs = useApp((s) => s.saveDocumentAs);

  const { id: documentId, name, bytes, password } = openDocument;
  const edited = canUndo(openDocument);
  const saved = openDocument.saved;

  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  /** Unscaled page sizes, in PDF points — the input to the whole layout. */
  const [sizes, setSizes] = useState<Size[]>([]);
  const [failure, setFailure] = useState<PdfLoadFailure | null>(null);
  const [editError, setEditError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragPage, setDragPage] = useState(0);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [mode, setMode] = useState<ViewMode>('view');
  const [modeEpoch, setModeEpoch] = useState(0);
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

  /**
   * Redraw generation per page. An edit rewrites the whole file, so every page
   * would otherwise be drawn again; this is what lets the untouched ones keep
   * the pixels they already have.
   */
  const [epochs, setEpochs] = useState<number[]>([]);
  /** What the edit currently in flight will have changed, once it lands. */
  const pendingInvalidation = useRef<Invalidation>('all');

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<DocumentMatch[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searching, setSearching] = useState(false);

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
        setEpochs((current) =>
          bumpEpochs(current, loadedSizes.length, pendingInvalidation.current),
        );
        pendingInvalidation.current = 'all';
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
  const continuousPage = pageAtOffset(offsets, contentTop, viewport.height);
  const [singlePage, setSinglePage] = useState(1);
  const page =
    pageLayout === 'single'
      ? Math.min(Math.max(1, singlePage), Math.max(1, pageCount || 1))
      : continuousPage;
  const range =
    pageLayout === 'single'
      ? { first: page, last: page }
      : visibleRange(offsets, contentTop, viewport.height, OVERSCAN);
  const columnWidth = useMemo(
    () => sizes.reduce((widest, size) => Math.max(widest, size.width), 0) * scale,
    [sizes, scale],
  );
  const columnHeight =
    pageLayout === 'single'
      ? PAGE_PADDING * 2 + (sizes[page - 1]?.height ?? 0) * scale
      : (offsets[offsets.length - 1] ?? 0) + PAGE_PADDING * 2;
  const panningActive = pointerTool === 'hand' || spaceHeld;

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
      const clamped = Math.max(1, Math.min(pageCount || 1, target));
      if (pageLayout === 'single') {
        setSinglePage(clamped);
        const element = scrollRef.current;
        if (element) element.scrollTop = 0;
        return;
      }
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = scrollTopForPage(offsets, clamped) + PAGE_PADDING;
    },
    [offsets, pageCount, pageLayout],
  );

  // ---- find ---------------------------------------------------------------

  /** Page text, cached per document; extracting it again per keystroke is slow. */
  const textCache = useRef(new Map<number, string[]>());
  useEffect(() => {
    textCache.current = new Map();
  }, [doc]);

  const runSearch = useCallback(
    async (needle: string) => {
      if (!doc || needle.trim() === '') {
        setMatches([]);
        setMatchIndex(0);
        return;
      }
      setSearching(true);
      try {
        const found: DocumentMatch[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          let items = textCache.current.get(pageNumber);
          if (!items) {
            items = await getPageTextItems(doc, pageNumber);
            textCache.current.set(pageNumber, items);
          }
          for (const range of findInItems(items, needle)) found.push({ page: pageNumber, ...range });
        }
        setMatches(found);
        setMatchIndex(0);
      } finally {
        setSearching(false);
      }
    },
    [doc],
  );

  const currentMatch = matches[matchIndex];

  // Stepping to a match is only useful if you can see it.
  useEffect(() => {
    if (!currentMatch) return;
    // Scroll / page jump is a response to the match index changing, not to
    // layout — do not re-run when zoom recomputes goToPage.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional navigation
    goToPage(currentMatch.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMatch]);

  /** Run indices to highlight, per page — computed once rather than per page. */
  const hitsByPage = useMemo(() => {
    const byPage = new Map<number, number[]>();
    for (const match of matches) {
      const runs = byPage.get(match.page) ?? [];
      for (let item = match.firstItem; item <= match.lastItem; item += 1) runs.push(item);
      byPage.set(match.page, runs);
    }
    return byPage;
  }, [matches]);

  const currentHitsByPage = useMemo(() => {
    if (!currentMatch) return new Map<number, number[]>();
    const runs: number[] = [];
    for (let item = currentMatch.firstItem; item <= currentMatch.lastItem; item += 1) runs.push(item);
    return new Map([[currentMatch.page, runs]]);
  }, [currentMatch]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery('');
    setMatches([]);
    setMatchIndex(0);
  }, []);

  // ---- editing ------------------------------------------------------------

  /**
   * Runs a tool straight over the bridge rather than through the store's
   * `runTool`: these edits fire on every click, and routing them through the
   * job list would add an entry per rotated page.
   */
  const runEdit = useCallback(
    async (
      toolId: string,
      params: Record<string, unknown>,
      invalidates: Invalidation,
      extra?: PickedFile,
    ) => {
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
            { name, bytes, mime: 'application/pdf' },
            ...(extra ? [{ name: extra.name, bytes: extra.bytes, mime: extra.mime }] : []),
          ],
          params: { ...params, password },
        });
        const output = result.files[0];
        if (!output) throw new Error('the tool produced no output');
        // Set only once the edit is certain to land. An edit that failed would
        // otherwise leave this pointing at its pages, and the next reload — an
        // undo, say — would trust it and leave the rest of the document stale.
        pendingInvalidation.current = invalidates;
        editDocument(documentId, output.bytes);
      } catch (cause) {
        setEditError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [bytes, documentId, editDocument, name, offsets, password, scale, sizes],
  );

  const rotatePage = (pageNumber: number) =>
    void runEdit('organize.rotate', { degrees: '90', mode: 'add', pages: String(pageNumber) }, [
      pageNumber,
    ]);

  const deletePage = (pageNumber: number) => {
    if (pageCount <= 1) {
      setEditError(t('viewerLastPage', locale));
      return;
    }
    void runEdit(
      'organize.remove-pages',
      { pages: String(pageNumber) },
      pagesFrom(pageNumber, pageCount),
    );
  };

  const movePage = (from: number, to: number) => {
    if (from === to) return;
    void runEdit(
      'organize.reorder',
      { preset: 'custom', order: reorderedPages(pageCount, from, to).join(',') },
      'all',
    );
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

      void runEdit(
        'security.redact',
        {
          keywords: '',
          pages: 'all',
          caseSensitive: false,
          regions: JSON.stringify([{ page: pageNumber, ...region }]),
        },
        [pageNumber],
      );
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
        [pageNumber],
        stampImage,
      );
    },
    [runEdit, sizes, stampImage],
  );

  const addTextAt = useCallback(
    (pageNumber: number, text: string, at: Point, box: Size) => {
      const pageSize = sizes[pageNumber - 1];
      if (!pageSize || text.trim() === '') return;
      const point = toPdfPoint(at, box, pageSize);
      void runEdit(
        'edit.add-text',
        {
          text: text.trim(),
          page: pageNumber,
          x: point.x,
          y: point.y,
          size: 14,
          color: '#111111',
        },
        [pageNumber],
      );
    },
    [runEdit, sizes],
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
    void runEdit(
      'edit.fill-form',
      {
        mode: 'fill',
        fields: changed
          .map((field) => `${field.name}=${(drafts[field.name] ?? '').replace(/[\r\n]+/g, ' ')}`)
          .join('\n'),
      },
      'all',
    );
  };

  const enterStampMode = async () => {
    const [image] = await bridge().pickFiles(['.png', '.jpg', '.jpeg'], false);
    if (!image) return;
    setStampImage(image);
    setMode('stamp');
    setModeEpoch((current) => current + 1);
  };

  const undo = useCallback(() => undoDocument(documentId), [documentId, undoDocument]);
  const redo = useCallback(() => redoDocument(documentId), [documentId, redoDocument]);

  /**
   * ⌘S overwrites the file that was opened, the way it does everywhere else.
   * A document with no path behind it — the output of a tool run, handed over
   * in memory — falls through to Save As inside the store.
   */
  const save = useCallback(async () => {
    setEditError('');
    try {
      await saveDocument(documentId);
    } catch (cause) {
      setEditError(
        `${t('viewerSaveFailed', locale)} — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }, [documentId, locale, saveDocument]);

  const saveAs = useCallback(async () => {
    setEditError('');
    try {
      await saveDocumentAs(documentId);
    } catch (cause) {
      setEditError(
        `${t('viewerSaveFailed', locale)} — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }, [documentId, locale, saveDocumentAs]);

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
        case 'find':
          setFindOpen(true);
          break;
        case 'dismiss':
          // Only ours to handle while the find bar is up; otherwise the shell
          // uses Escape to close the palette and the job panel.
          if (!findOpen) return;
          closeFind();
          break;
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
    closeFind,
    findOpen,
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
    setModeEpoch((current) => current + 1);
    if (next !== 'stamp') setStampImage(null);
  };

  if (failure === 'needs-password' || failure === 'wrong-password') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setDocumentPassword(documentId, passwordDraft);
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
    <div className="flex h-full min-h-0 flex-col">
      <PdfChrome
        locale={locale}
        busy={busy}
        edited={edited}
        saved={saved}
        page={page}
        pageCount={pageCount}
        scale={scale}
        fit={fit}
        mode={mode}
        pointerTool={pointerTool}
        pageLayout={pageLayout}
        canRedo={canRedo(openDocument)}
        onZoomIn={() => zoomBy(1)}
        onZoomOut={() => zoomBy(-1)}
        onZoomActual={() => zoomTo(1, viewport.height / 2)}
        onFitWidth={() => setFit('width')}
        onFitPage={() => setFit('page')}
        onPrevPage={() => goToPage(page - 1)}
        onNextPage={() => goToPage(page + 1)}
        onRotatePage={() => rotatePage(page)}
        onUndo={undo}
        onRedo={redo}
        onSave={() => void save()}
        onSaveAs={() => void saveAs()}
        onFind={() => setFindOpen(true)}
        onMode={(next) => {
          if (next === 'stamp' && mode !== 'stamp') void enterStampMode();
          else switchMode(next);
        }}
        onPointerTool={setPointerTool}
        onPageLayout={(layout) => {
          setPageLayout(layout);
          if (layout === 'single') setSinglePage(page);
        }}
        onChooseTool={onChooseTool}
        onOpenFileMenu={() => setFileMenuOpen(true)}
        onRunTool={(toolId) => onRunTool?.(toolId)}
      />

      <div className="relative flex min-h-0 flex-1">
      <PdfFileMenu
        locale={locale}
        open={fileMenuOpen}
        onClose={() => setFileMenuOpen(false)}
        onOpen={() => onOpenDocument?.()}
        onSave={() => void save()}
        onSaveAs={() => void saveAs()}
        onPrint={() => window.print()}
        onSettings={() => onOpenSettings?.()}
        onRunTool={(toolId) => onRunTool?.(toolId)}
        onOpenRecent={(path) => onOpenRecent?.(path)}
      />
      {/* Narrow WPS-style rail; expands to thumbnails. */}
      <aside
        className={clsx(
          'flex shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-panel)]',
          thumbsOpen ? 'w-[7.5rem]' : 'w-10',
        )}
        title={t('viewerDragHint', locale)}
      >
        <button
          type="button"
          onClick={() => setThumbsOpen((open) => !open)}
          className="flex h-9 items-center justify-center border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          title={t('pdfThumbs', locale)}
          aria-expanded={thumbsOpen}
        >
          {thumbsOpen ? t('pdfThumbs', locale) : '⋮'}
        </button>
        {thumbsOpen && (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {doc &&
              sizes.map((size, index) => (
                <Thumbnail
                  key={index + 1}
                  doc={doc}
                  pageNumber={index + 1}
                  size={size}
                  epoch={epochs[index] ?? 0}
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
          </div>
        )}
      </aside>

      {/* min-w-0 matters: without it a flex item cannot shrink below its
          content, so the toolbar getting one element wider — the "edited" badge
          appearing after the first edit — would push this column past the
          window, widen the page area, and re-solve fit-width. The whole
          document would visibly re-zoom on the first rotate. */}
      <div className="relative flex min-h-0 w-0 min-w-0 flex-1 flex-col">

        {findOpen && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              // Enter re-runs a new query, or steps to the next hit of the one
              // already run — the same key doing the obvious thing either way.
              if (matches.length === 0) void runSearch(query);
              else setMatchIndex((current) => nextMatchIndex(current, matches.length, 1));
            }}
            className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-2"
          >
            <Search size={14} className="shrink-0 text-[var(--text-muted)]" />
            <input
              autoFocus
              value={query}
              placeholder={t('findPlaceholder', locale)}
              aria-label={t('findPlaceholder', locale)}
              onChange={(event) => {
                setQuery(event.target.value);
                setMatches([]);
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-muted)]"
            />
            <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
              {searching
                ? t('findSearching', locale)
                : matches.length === 0
                  ? query.trim() === ''
                    ? ''
                    : t('findNone', locale)
                  : `${matchIndex + 1}/${matches.length}`}
            </span>
            <ToolbarButton
              label={t('findPrevious', locale)}
              disabled={matches.length === 0}
              onClick={() => setMatchIndex((current) => nextMatchIndex(current, matches.length, -1))}
            >
              <ChevronLeft size={14} />
            </ToolbarButton>
            <ToolbarButton
              label={t('findNext', locale)}
              disabled={matches.length === 0}
              onClick={() => setMatchIndex((current) => nextMatchIndex(current, matches.length, 1))}
            >
              <ChevronRight size={14} />
            </ToolbarButton>
            <ToolbarButton label={t('close', locale)} onClick={closeFind}>
              <X size={14} />
            </ToolbarButton>
          </form>
        )}

        {mode === 'redact' && (
          <Banner tone="danger" icon={<Eraser size={13} className="shrink-0" />}>
            <span className="min-w-0 flex-1">{t('viewerRedactHint', locale)}</span>
          </Banner>
        )}

        {mode === 'text' && (
          <Banner tone="accent" icon={<PenLine size={13} className="shrink-0" />}>
            <span className="min-w-0 flex-1">{t('viewerTextHint', locale)}</span>
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
            if (!panningActive || !scrollRef.current) return;
            // Select tool keeps text selection; only left-button pan for hand.
            if (pointerTool === 'select' && !spaceHeld) return;
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
            'min-h-0 flex-1 overflow-auto bg-[var(--pdf-desk)]',
            panningActive && (grabbing ? 'cursor-grabbing' : 'cursor-grab'),
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
                const top =
                  pageLayout === 'single'
                    ? PAGE_PADDING
                    : PAGE_PADDING + (offsets[index] ?? 0);
                return (
                  <PageView
                    key={pageNumber}
                    doc={doc}
                    pageNumber={pageNumber}
                    size={size}
                    scale={scale}
                    locale={locale}
                    mode={mode}
                    modeEpoch={modeEpoch}
                    busy={busy}
                    panning={panningActive}
                    drafts={drafts}
                    fields={fieldsByPage.get(pageNumber)}
                    top={top}
                    epoch={epochs[index] ?? 0}
                    hits={hitsByPage.get(pageNumber) ?? NO_HITS}
                    currentHits={currentHitsByPage.get(pageNumber) ?? NO_HITS}
                    onFields={onPageFields}
                    onDraftChange={(name, value) =>
                      setDrafts((current) => ({ ...current, [name]: value }))
                    }
                    onRedact={redactBox}
                    onStamp={stampAt}
                    onText={addTextAt}
                  />
                );
              })}
            </div>
          )}
        </div>

        {onRunTool && (
          <PdfQuickConvert
            locale={locale}
            disabled={!doc || busy}
            onConvert={(toolId) => onRunTool(toolId)}
          />
        )}

        <PdfStatusBar
          locale={locale}
          page={page}
          pageCount={pageCount}
          scale={scale}
          pageLayout={pageLayout}
          byteLength={bytes.length}
          disabled={!doc || busy}
          onPrevPage={() => goToPage(page - 1)}
          onNextPage={() => goToPage(page + 1)}
          onGoToPage={goToPage}
          onZoomIn={() => zoomBy(1)}
          onZoomOut={() => zoomBy(-1)}
          onZoomTo={(next) => {
            setFit(null);
            zoomTo(next, viewport.height / 2);
          }}
          onPageLayout={(layout) => {
            setPageLayout(layout);
            if (layout === 'single') setSinglePage(page);
          }}
        />
      </div>
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
  locale,
  mode,
  modeEpoch,
  busy,
  panning,
  drafts,
  fields,
  top,
  epoch,
  hits,
  currentHits,
  onFields,
  onDraftChange,
  onRedact,
  onStamp,
  onText,
}: {
  doc: PdfDocumentHandle;
  pageNumber: number;
  size: Size;
  scale: number;
  locale: Locale;
  mode: ViewMode;
  modeEpoch: number;
  busy: boolean;
  panning: boolean;
  drafts: Record<string, string>;
  fields: FormFieldBox[] | undefined;
  top: number;
  /** Bumped when this page's content changed; unchanged means keep the pixels. */
  epoch: number;
  /** Text-run indices on this page that a search matched. */
  hits: readonly number[];
  /** The subset of `hits` belonging to the match currently stepped to. */
  currentHits: readonly number[];
  onFields(source: PdfDocumentHandle, pageNumber: number, fields: FormFieldBox[]): void;
  onDraftChange(name: string, value: string): void;
  onRedact(pageNumber: number, from: Point, to: Point, box: Size): void;
  onStamp(pageNumber: number, at: Point, box: Size): void;
  onText(pageNumber: number, text: string, at: Point, box: Size): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  /** The span per text run, as returned by the last text-layer render. */
  const textDivs = useRef<HTMLElement[]>([]);
  const [textVersion, setTextVersion] = useState(0);
  const [marquee, setMarquee] = useState<{ from: Point; to: Point } | null>(null);
  const [textEditor, setTextEditor] = useState<{
    at: Point;
    value: string;
    epoch: number;
  } | null>(null);

  /**
   * What is currently on the canvas and in the text layer. An edit hands over a
   * new document object, but a page it did not touch is the same picture — so
   * this is what decides whether there is any work to do.
   */
  const drawn = useRef({ epoch: -1, scale: 0 });
  const laidOut = useRef({ epoch: -1, scale: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (drawn.current.epoch === epoch && drawn.current.scale === scale) return;

    let stale = false;
    void renderPageToCanvas(doc, pageNumber, canvas, scale, devicePixels(), () => stale)
      .then(() => {
        if (!stale) drawn.current = { epoch, scale };
      })
      .catch(() => {
        // A page that will not draw leaves the previous image up; the load
        // failure the document itself reports is the one worth surfacing.
      });
    return () => {
      stale = true;
    };
  }, [doc, epoch, pageNumber, scale]);

  // The text layer has to be laid out again at every zoom, since pdf.js sizes
  // the container from the scale rather than letting CSS stretch it.
  useEffect(() => {
    const container = textLayerRef.current;
    if (!container) return;
    if (laidOut.current.epoch === epoch && laidOut.current.scale === scale) return;

    let stale = false;
    void renderTextLayer(doc, pageNumber, container, scale)
      .then((divs) => {
        if (stale) return;
        laidOut.current = { epoch, scale };
        textDivs.current = divs;
        // Highlights are applied to these spans, so re-applying them has to
        // wait for the spans to exist.
        setTextVersion((version) => version + 1);
      })
      .catch(() => {
        // A page whose text will not extract is still readable and printable;
        // it simply cannot be selected or found.
      });
    return () => {
      stale = true;
    };
  }, [doc, epoch, pageNumber, scale]);

  useEffect(() => {
    const marked = new Set(hits);
    const current = new Set(currentHits);
    for (const [index, span] of textDivs.current.entries()) {
      span.classList.toggle('find-hit', marked.has(index) && !current.has(index));
      span.classList.toggle('find-hit-current', current.has(index));
    }
  }, [hits, currentHits, textVersion]);

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
          if (!interactive) return;
          const box = e.currentTarget.getBoundingClientRect();
          const at = { x: e.clientX - box.left, y: e.clientY - box.top };
          if (mode === 'text') setTextEditor({ at, value: '', epoch: modeEpoch });
          if (mode === 'stamp') {
            onStamp(pageNumber, at, { width: box.width, height: box.height });
          }
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
        <canvas
          ref={canvasRef}
          className="block bg-white"
          style={{ boxShadow: 'var(--pdf-page-shadow)' }}
        />

        {/* Selection would fight the marquee and the stamp click, so the text
            layer only takes the pointer while plain reading is going on. */}
        <div
          ref={textLayerRef}
          className={clsx('text-layer', mode !== 'view' && 'pointer-events-none')}
          style={{ '--total-scale-factor': scale } as React.CSSProperties}
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

        {mode === 'text' && textEditor?.epoch === modeEpoch && (
          <form
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              if (textEditor.value.trim() === '') return;
              onText(
                pageNumber,
                textEditor.value,
                textEditor.at,
                { width: size.width * scale, height: size.height * scale },
              );
              setTextEditor(null);
            }}
            className="absolute z-10 flex h-9 w-[240px] items-center gap-1 rounded-lg border border-[var(--accent)] bg-[var(--surface-panel)] p-1 shadow-xl"
            style={{
              left: Math.max(0, Math.min(textEditor.at.x, size.width * scale - 240)),
              top: Math.max(0, Math.min(textEditor.at.y, size.height * scale - 36)),
            }}
          >
            <input
              autoFocus
              value={textEditor.value}
              placeholder={t('viewerTextPlaceholder', locale)}
              onChange={(event) => setTextEditor({ ...textEditor, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                setTextEditor(null);
              }}
              className="min-w-0 flex-1 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-[var(--text-muted)]"
            />
            <button
              type="submit"
              className="h-7 shrink-0 rounded-md bg-[var(--accent)] px-2 text-[11px] font-medium text-white"
            >
              {t('viewerTextAdd', locale)}
            </button>
          </form>
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
  epoch,
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
  epoch: number;
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

  const drawn = useRef({ epoch: -1, scale: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    // A strip of a hundred thumbnails would otherwise redraw on every rotate.
    if (drawn.current.epoch === epoch && drawn.current.scale === scale) return;

    let stale = false;
    void renderPageToCanvas(doc, pageNumber, canvas, scale, devicePixels(), () => stale)
      .then(() => {
        if (!stale) drawn.current = { epoch, scale };
      })
      .catch(() => {
        // Same as the main page: keep whatever was already drawn.
      });
    return () => {
      stale = true;
    };
  }, [visible, doc, epoch, pageNumber, scale]);

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
