import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { bridge, type PickedFile } from '../bridge.ts';
import { t } from '../i18n.ts';
import { createEditQueue } from '../editQueue.ts';
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
  Search,
  Stamp,
  X,
  ListTree,
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
import { canRedo, canUndo, isDirty, type DocumentState } from '../documents.ts';
import { currentPlatform, isTypingTarget, matchShortcut } from '../shortcuts.ts';
import { reorderedPages } from '../pdf/pageOrder.ts';
import {
  getPageSizes,
  getPageTextItems,
  loadPdfDocument,
  type FormFieldBox,
  type PdfDocumentHandle,
} from '../pdf/renderer.ts';
import { Button } from './ui.tsx';
import { PdfChrome, type PdfPageLayout, type PdfPointerTool } from './PdfChrome.tsx';
import { PdfFileMenu } from './PdfFileMenu.tsx';
import { PdfQuickConvert } from './PdfQuickConvert.tsx';
import { PdfStatusBar } from './PdfStatusBar.tsx';
import { OutlinePanel } from './OutlinePanel.tsx';
import { PageView } from './PageView.tsx';
import { Thumbnail } from './Thumbnail.tsx';

import { TextSelectionMenu } from './TextSelectionMenu.tsx';
import { selectionOnPages, type RenderedPage } from '../pdf/selectionGeometry.ts';
import { HIGHLIGHT_COLORS, type HighlightColor } from '../pdf/highlights.ts';
import { HighlightToolbar } from './HighlightToolbar.tsx';
import type { InkAnnotation } from '../pdf/inkAnnotation.ts';

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
  onAiPrompt?(prompt: string): void;
}

/** Pages kept rendered on each side of the viewport so scrolling never shows blanks. */
const OVERSCAN = 1;

type ViewMode = 'view' | 'text' | 'redact' | 'stamp' | 'form' | 'draw';
type FitMode = 'width' | 'page' | null;

/** Shared empty map, so a document with no widgets yet does not remount overlays. */
const NO_FIELDS: ReadonlyMap<number, FormFieldBox[]> = new Map();
/** Shared empty list, so a page with no hits does not get a new array each render. */
const NO_HITS: readonly number[] = [];

/** A search hit, located by page as well as by the runs it covers. */
interface DocumentMatch extends ItemRange {
  page: number;
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
  onAiPrompt,
}: ViewerProps) {
  const locale = useApp((s) => s.locale);

  const handleAiAction = (action: 'summarize' | 'translate' | 'polish', text: string) => {
    let prompt = '';
    if (action === 'summarize') {
      prompt = locale === 'zh'
        ? `请对以下选中文本进行核心要点总结：\n\n"${text}"`
        : `Please summarize the key points of the following text:\n\n"${text}"`;
    } else if (action === 'translate') {
      prompt = locale === 'zh'
        ? `请将以下选中文本翻译为中文（如果原文本已是中文则翻译为英文）：\n\n"${text}"`
        : `Please translate the following text into English (or into Chinese if already English):\n\n"${text}"`;
    } else if (action === 'polish') {
      prompt = locale === 'zh'
        ? `请对以下选中文本进行结构化提炼与语言润色：\n\n"${text}"`
        : `Please refine and polish the language of the following text:\n\n"${text}"`;
    }
    onAiPrompt?.(prompt);
  };
  const [sidebarTab, setSidebarTab] = useState<'thumbs' | 'outline' | 'none'>('thumbs');
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
  // The badge says "saved" exactly when there is nothing to write.
  const saved = !isDirty(openDocument);

  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  /** Unscaled page sizes, in PDF points — the input to the whole layout. */
  const [sizes, setSizes] = useState<Size[]>([]);
  const [failure, setFailure] = useState<PdfLoadFailure | null>(null);
  const [editError, setEditError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragPage, setDragPage] = useState(0);
  const [passwordDraft, setPasswordDraft] = useState('');
  const [mode, setMode] = useState<ViewMode>('view');
  const [nightMode, setNightMode] = useState(false);
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
  /** The document the drafts belong to; a different one means they are stale. */
  const fieldSourceRef = useRef<PdfDocumentHandle | null>(null);
  /** Edits run one at a time; see `editQueue.ts` for why. */
  const editQueue = useMemo(() => createEditQueue(), []);
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

  /**
   * Which search the results on screen belong to.
   *
   * Extracting text from a long document takes a while, and every keystroke
   * starts another search. Without this, typing `B` while the search for `A`
   * was still walking the pages let A finish last and overwrite B's results —
   * the list then belonged to a word the user had already replaced.
   */
  const searchRun = useRef(0);

  /**
   * Abandon whatever search is running, because what it was asked has changed.
   *
   * Clearing the matches was not enough: the search still owned the run
   * number, so it finished and filled its own results back in against a box
   * that now said something else. The next Enter then saw a non-empty list and
   * stepped through the old word's hits instead of searching for the new one.
   *
   * It also clears `searching`, which nothing else would: an abandoned run's
   * own `finally` does not, precisely because it is no longer current.
   */
  const invalidateSearch = useCallback(() => {
    searchRun.current += 1;
    setMatches([]);
    setMatchIndex(0);
  }, []);

  /**
   * How many searches are still walking pages.
   *
   * `searching` used to be cleared by whichever run was still the current one,
   * which meant an abandoned run cleared nothing — so emptying the box while a
   * search was running left the bar saying "searching…" for good. Whoever
   * finishes last turns the light off instead.
   */
  const searchesInFlight = useRef(0);

  /** Page text, cached per document; extracting it again per keystroke is slow. */
  const textCache = useRef(new Map<number, string[]>());
  useEffect(() => {
    textCache.current = new Map();
    // A search still walking the document that has just been replaced would
    // otherwise finish and report hits at pages and offsets from the old one.
    searchRun.current += 1;
  }, [doc]);

  const runSearch = useCallback(
    async (needle: string) => {
      const run = (searchRun.current += 1);
      const isCurrent = () => searchRun.current === run;

      if (!doc || needle.trim() === '') {
        setMatches([]);
        setMatchIndex(0);
        return;
      }
      searchesInFlight.current += 1;
      setSearching(true);
      try {
        const found: DocumentMatch[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          let items = textCache.current.get(pageNumber);
          if (!items) {
            items = await getPageTextItems(doc, pageNumber);
            // Abandoned mid-walk: a newer search owns the screen now, and the
            // cache entry above is still worth keeping for it.
            if (!isCurrent()) return;
            textCache.current.set(pageNumber, items);
          }
          for (const range of findInItems(items, needle)) found.push({ page: pageNumber, ...range });
        }
        if (!isCurrent()) return;
        setMatches(found);
        setMatchIndex(0);
      } catch (cause) {
        // A page that cannot be read is not a reason to leave the previous
        // results standing as if they answered this search.
        if (isCurrent()) {
          console.warn('[viewer] search failed:', cause);
          setMatches([]);
          setMatchIndex(0);
        }
      } finally {
        searchesInFlight.current -= 1;
        // Not `isCurrent()`: a run that was abandoned still has to account for
        // itself, or the bar keeps saying "searching…" with nothing running.
        if (searchesInFlight.current === 0) setSearching(false);
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
    invalidateSearch();
  }, [invalidateSearch]);

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
        await editQueue.run(async () => {
          // The document as it is *now*, not as it was when this was queued.
          // Each edit replaces the document whole, so one that started from
          // stale bytes silently undoes the edit before it — two pen strokes
          // on different pages, and only the second one is in the file.
          const current = useApp.getState().documents.find((entry) => entry.id === documentId);
          const result = await bridge().runJob({
            jobId: crypto.randomUUID(),
            toolId,
            files: [
              { name, bytes: current?.bytes ?? bytes, mime: 'application/pdf' },
              ...(extra ? [{ name: extra.name, bytes: extra.bytes, mime: extra.mime }] : []),
            ],
            params: { ...params, password: current?.password ?? password },
          });
          const output = result.files[0];
          if (!output) throw new Error('the tool produced no output');
          // Set only once the edit is certain to land. An edit that failed would
          // otherwise leave this pointing at its pages, and the next reload — an
          // undo, say — would trust it and leave the rest of the document stale.
          pendingInvalidation.current = invalidates;
          editDocument(documentId, output.bytes);
        });
      } catch (cause) {
        setEditError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        // Only when nothing else is still running. Whichever edit finished
        // first used to clear this while the next was still in flight, so the
        // viewer said it was idle and went on accepting more.
        if (editQueue.pending === 0) setBusy(false);
      }
    },
    [bytes, documentId, editDocument, editQueue, name, offsets, password, scale, sizes],
  );

  /** Which colour the highlight palette is set to. */
  const [highlightColor, setHighlightColor] = useState<HighlightColor>('yellow');

  /**
   * Marks are an edit like any other: they go through the same tool run, so
   * they land in the same undo history as a page rotation, mark the document
   * dirty, and reach the file on ⌘S. Nothing extra had to be built for any of
   * that — which is the reason they are a tool run rather than state of their
   * own.
   */
  const writeMarks = (annotations: {
    highlights: { pageNumber: number; rects: unknown[]; color: string }[];
    ink: { pageNumber: number; points: unknown[]; color: string; strokeWidth: number }[];
  }, touched: number[]) =>
    void runEdit('edit.annotate', { annotations: JSON.stringify(annotations) }, touched);

  /** Where every rendered page currently sits, for placing a selection. */
  const renderedPages = (): RenderedPage[] => {
    const element = scrollRef.current;
    if (!element) return [];
    return [...element.querySelectorAll('[data-page-number]')].flatMap((node) => {
      const pageNumber = Number(node.getAttribute('data-page-number'));
      if (!Number.isInteger(pageNumber)) return [];
      const box = node.getBoundingClientRect();
      return [{ pageNumber, left: box.left, top: box.top, width: box.width, height: box.height }];
    });
  };

  const highlightSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const rects = [...selection.getRangeAt(0).getClientRects()];
    const onPages = selectionOnPages(rects, renderedPages(), scale);
    if (onPages.length === 0) return;

    selection.removeAllRanges();
    writeMarks(
      {
        highlights: onPages.map((entry) => ({
          pageNumber: entry.pageNumber,
          rects: entry.rects,
          color: HIGHLIGHT_COLORS[highlightColor],
        })),
        ink: [],
      },
      onPages.map((entry) => entry.pageNumber),
    );
  };

  const addInk = (pageNumber: number, stroke: Omit<InkAnnotation, 'id' | 'pageNumber'>) =>
    writeMarks(
      {
        highlights: [],
        ink: [{
          pageNumber,
          points: stroke.points,
          color: stroke.color,
          strokeWidth: stroke.strokeWidth,
        }],
      },
      [pageNumber],
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
      const sameDocument = fieldSourceRef.current === source;
      fieldSourceRef.current = source;

      setFieldCache((current) => {
        // A page that finished reading after an edit landed belongs to the old
        // document; start a fresh map rather than mixing the two.
        const byPage =
          current.source === source ? new Map(current.byPage) : new Map<number, FormFieldBox[]>();
        byPage.set(pageNumber, found);
        return { source, byPage };
      });
      setDrafts((current) => {
        // Keeping what the user typed is right while it is the same document —
        // scrolling a page back into view must not wipe out a half-typed
        // answer. Across an edit it is wrong: after an undo the box went on
        // showing the value that was undone, and applying again wrote it
        // straight back into the file.
        const next = sameDocument ? { ...current } : {};
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
    // One line per field, not per widget: a radio group is several widgets
    // under one name and would otherwise repeat itself.
    const lines = new Map<string, string>();
    for (const field of changed) {
      lines.set(field.name, (drafts[field.name] ?? '').replace(/[\r\n]+/g, ' '));
    }
    void runEdit(
      'edit.fill-form',
      {
        mode: 'fill',
        fields: [...lines].map(([name, value]) => `${name}=${value}`).join('\n'),
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
   * Prints the document, not the window.
   *
   * The main process opens these bytes in Chromium's PDF viewer and prints
   * that, which is why every page comes out and none of this application does
   * — the viewer only ever mounts the pages near the one being read (#27).
   * The bytes as the tab has them, so an unsaved rotation prints rotated.
   *
   * One function behind all three entry points: the shortcut, the toolbar and
   * the file menu, which used to be two different things and a `window.print`.
   */
  const print = useCallback(async () => {
    setEditError('');
    try {
      // Unlocking a document here only tells pdf.js the password — the bytes
      // are still the encrypted file. The print path hands them to a separate
      // Chromium PDF viewer that has no password to give, so an encrypted
      // document printed nothing at all ("Printing failed"), even though the
      // tab in front of the user was open and readable.
      //
      // A decrypted copy is made for the print alone. It is not written to the
      // document and never outlives the temp file the printer already removes.
      let printable = bytes;
      if (password) {
        const unlocked = await bridge().runJob({
          jobId: crypto.randomUUID(),
          toolId: 'security.remove-password',
          files: [{ name, bytes, mime: 'application/pdf' }],
          params: { password },
        });
        printable = unlocked.files[0]?.bytes ?? bytes;
      }
      await bridge().printPdf(printable, name, pageCount);
    } catch (cause) {
      setEditError(
        `${t('viewerPrintFailed', locale)} — ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }, [bytes, locale, name, pageCount, password]);

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
        case 'print':
          void print();
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
    // `print` closes over the document's current bytes, so a stale one would
    // print the document as it was before the last edit.
    print,
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
        nightMode={nightMode}
        pointerTool={pointerTool}
        pageLayout={pageLayout}
        canRedo={canRedo(openDocument)}
        onZoomIn={() => zoomBy(1)}
        onZoomOut={() => zoomBy(-1)}
        onZoomActual={() => zoomTo(1, viewport.height / 2)}
        onFitWidth={() => setFit('width')}
        onFitPage={() => setFit('page')}
        onToggleNightMode={() => setNightMode((v) => !v)}
        onPrint={() => void print()}
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
        onPrint={() => void print()}
        onSettings={() => onOpenSettings?.()}
        onRunTool={(toolId) => onRunTool?.(toolId)}
        onOpenRecent={(path) => onOpenRecent?.(path)}
      />
      {/* Narrow WPS-style rail; expands to thumbnails. */}
      <aside
        className={clsx(
          'flex shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-panel)]',
          sidebarTab !== 'none' ? 'w-48' : 'w-10',
        )}
      >
        <div className="flex h-9 border-b border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => setSidebarTab((current) => (current === 'thumbs' ? 'none' : 'thumbs'))}
            className={clsx(
              'flex flex-1 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              sidebarTab === 'thumbs' && 'bg-[var(--surface-hover)] text-[var(--accent)]',
            )}
            title={t('pdfThumbs', locale)}
          >
            {sidebarTab !== 'none' ? 'T' : '⋮'}
          </button>
          {sidebarTab !== 'none' && (
            <button
              type="button"
              onClick={() => setSidebarTab('outline')}
              className={clsx(
                'flex flex-1 items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                sidebarTab === 'outline' && 'bg-[var(--surface-hover)] text-[var(--accent)]',
              )}
              title={t('pdfOutline', locale)}
            >
              <ListTree size={15} />
            </button>
          )}
        </div>
        {sidebarTab === 'thumbs' && (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2" title={t('viewerDragHint', locale)}>
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
        {sidebarTab === 'outline' && <OutlinePanel doc={doc} locale={locale} onGoToPage={goToPage} />}
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
                invalidateSearch();
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

        {mode === 'draw' && (
          <Banner tone="accent" icon={<PenLine size={13} className="shrink-0" />}>
            <span className="min-w-0 flex-1">
              {locale === 'zh' ? '自由画笔模式：在页面上按住拖拽即可绘图。' : 'Freehand draw mode: click and drag on pages to draw.'}
            </span>
          </Banner>
        )}

        {mode === 'text' && (
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-4 py-1.5 text-xs">
            <span className="text-[var(--text-muted)]">
              {locale === 'zh'
                ? '点击页面插入文本，或选中文字后高亮：'
                : 'Click a page to insert text, or select text and highlight it:'}
            </span>
            <HighlightToolbar
              locale={locale}
              activeColor={highlightColor}
              onChangeColor={(color) => setHighlightColor(color ?? 'yellow')}
            />
          </div>
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
              <TextSelectionMenu
                containerRef={scrollRef}
                locale={locale}
                onAiAction={handleAiAction}
                onHighlightText={highlightSelection}
              />
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
                    nightMode={nightMode}
                    modeEpoch={modeEpoch}
                    busy={busy}
                    panning={panningActive}
                    drafts={drafts}
                    fields={fieldsByPage.get(pageNumber)}
                    onGoToPage={goToPage}
                    top={top}
                    epoch={epochs[index] ?? 0}
                    hits={hitsByPage.get(pageNumber) ?? NO_HITS}
                    currentHits={currentHitsByPage.get(pageNumber) ?? NO_HITS}
                    inkAnnotations={openDocument.inkAnnotations?.[pageNumber] ?? []}
                    onAddInkAnnotation={addInk}
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
