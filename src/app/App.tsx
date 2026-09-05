import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { defaultParams } from '@core/params.ts';
import type { ToolMeta, ToolOutputFile } from '@core/types.ts';
import { uiRegistry } from './catalog.ts';
import {
  bridge,
  hasBridge,
  type OfficeCreateKind,
  type PickedFile,
} from './bridge.ts';
import { localized, t } from './i18n.ts';
import { AlertCircle, Bot, Check, Eye, Loader2, Save, Settings, ToolIcon, X } from './icons.ts';
import { currentPlatform, isTypingTarget, matchShortcut } from './shortcuts.ts';
import { useApp } from './store.ts';
import {
  isDirty,
  normalizeDocumentPath,
  officeCreateKind,
  partitionOpenPaths,
  setPathCaseSensitivity,
  type DocumentState,
} from './documents.ts';
import { createOpenGuard } from './openGuard.ts';
import {
  canApplyInstantly,
  canOpenFromDocument,
  canQuickApplyWithConfirm,
} from './toolApply.ts';
import { officeUiThemeFor, partitionDocumentPaths } from './office.ts';
import { createReloadQueue } from './officeReload.ts';

/**
 * Whether two spellings of a path name one file is a property of the machine,
 * not of a document, so it is answered once. Linux keeps them apart; the
 * default folds, which is what Windows and macOS do.
 */
if (hasBridge()) setPathCaseSensitivity(bridge().platform);

/**
 * One at a time per file, across every route into opening: a tab exists too
 * late to deduplicate against, so two overlapping requests for one document
 * would each create an engine session and only one would ever be closed.
 */
const openGuard = createOpenGuard();
import {
  EMPTY_APPROVAL_STATE,
  withDecision,
  withRequest,
  withTimeout,
  type ApprovalDecision,
} from './ai/officeApprovals.ts';
import { createDefaultBlankPdf } from './pdf/directEdit.ts';
import { CommandPalette } from './components/CommandPalette.tsx';
import { ApplyToolPanel } from './components/ApplyToolPanel.tsx';
import { DocumentTabs } from './components/DocumentTabs.tsx';
import { Home } from './components/Home.tsx';
import { Ribbon } from './components/Ribbon.tsx';
import { ToolPage } from './components/ToolPage.tsx';
import { UpdatePrompt } from './components/UpdatePrompt.tsx';
import { Button } from './components/ui.tsx';

/** Brief feedback after a one-shot ribbon tool (WPS-style, no pane). */
type TaskFeedback =
  | { kind: 'working'; title: string }
  | { kind: 'ok'; title: string; detail?: string }
  | { kind: 'error'; title: string; detail: string }
  | { kind: 'files'; title: string; summary?: string; files: ToolOutputFile[] };

/**
 * Screens that most sessions never open, kept out of the entry chunk.
 *
 * The Viewer is here because pdfjs-dist is ~1 MB on its own. The rest are here
 * because they are big and conditional: a pipeline builder, a batch runner, a
 * signature pad and the settings panel are each a page someone visits
 * occasionally, and none of them should be parsed before the window paints.
 */
const Viewer = lazy(() =>
  import('./components/Viewer.tsx').then((module) => ({ default: module.Viewer })),
);
const BatchPage = lazy(() =>
  import('./components/BatchPage.tsx').then((module) => ({ default: module.BatchPage })),
);
const PipelinePage = lazy(() =>
  import('./components/PipelinePage.tsx').then((module) => ({ default: module.PipelinePage })),
);
const SettingsPanel = lazy(() =>
  import('./components/SettingsPanel.tsx').then((module) => ({ default: module.SettingsPanel })),
);
const OnboardingWizard = lazy(() =>
  import('./components/OnboardingWizard.tsx').then((module) => ({ default: module.OnboardingWizard })),
);
const SignPage = lazy(() =>
  import('./components/SignPage.tsx').then((module) => ({ default: module.SignPage })),
);
const OfficeEditor = lazy(() =>
  import('./components/OfficeEditor.tsx').then((module) => ({ default: module.OfficeEditor })),
);
const AIChatPanel = lazy(() =>
  import('./components/AIChatPanel.tsx').then((module) => ({ default: module.AIChatPanel })),
);

/**
 * How long a rewritten document waits for the next write before the editor is
 * reopened. One AI request often rewrites the same file several times, and each
 * reopen is a full engine boot — long enough to look like the app restarting.
 */
const REOPEN_SETTLE_MS = 900;

/** Shown while one of the screens above is being fetched. */
function ScreenFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 size={22} className="animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

type MainView =
  | { name: 'welcome' }
  | { name: 'tool'; toolId: string; initialFile?: PickedFile }
  | { name: 'document' };

export function App() {
  const ready = useApp((s) => s.ready);
  const locale = useApp((s) => s.locale);
  const updateSettings = useApp((s) => s.updateSettings);
  const startupError = useApp((s) => s.startupError);
  const initialize = useApp((s) => s.initialize);
  const documents = useApp((s) => s.documents);
  const activeDocumentId = useApp((s) => s.activeDocumentId);
  const openDocument = useApp((s) => s.openDocument);
  const closeDocument = useApp((s) => s.closeDocument);
  const setActiveDocument = useApp((s) => s.setActiveDocument);
  const saveDocument = useApp((s) => s.saveDocument);
  const saveDocumentAs = useApp((s) => s.saveDocumentAs);
  const setEngineModified = useApp((s) => s.setEngineModified);
  const engineSaveRequest = useApp((s) => s.engineSaveRequest);
  const engineSaved = useApp((s) => s.engineSaved);
  const engineSaveFailed = useApp((s) => s.engineSaveFailed);

  const [main, setMain] = useState<MainView>({ name: 'welcome' });
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Set while the palette was opened from the document toolbar, so the results
  // are scoped to tools that accept a PDF.
  const [paletteForDocument, setPaletteForDocument] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMounted, setAiMounted] = useState(false);
  // A tab being closed with unsaved changes, held until the user decides.
  const [closing, setClosing] = useState<DocumentState | null>(null);
  // The tool being run against the open document, if any.
  const [applying, setApplying] = useState<ToolMeta | null>(null);
  // Simple default-option tools: confirm once before applying with catalogue defaults.
  const [quickConfirm, setQuickConfirm] = useState<ToolMeta | null>(null);
  // One-shot tools: spinner / success / error / save-outputs toast.
  const [taskFeedback, setTaskFeedback] = useState<TaskFeedback | null>(null);
  const taskFeedbackTimer = useRef<number | null>(null);
  // Nested dragenter/dragleave pairs fire per child element; counting them is
  // the only reliable way to know the pointer has truly left the window.
  const dragDepth = useRef(0);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState('');
  // The Office files being rendered right now. Rendering is seconds of silence
  // otherwise, which reads as the app having ignored the click.
  const [opening, setOpening] = useState<string[]>([]);

  /**
   * Clears the drop overlay whatever swallowed the event.
   *
   * A tool's own drop zone calls `stopPropagation`, so dropping on one never
   * reaches the window handler below and the depth counter would stay above
   * zero — leaving "release to open" on screen for good. These listeners are
   * on the capture phase, which a child cannot stop, and `dragend` covers a
   * drag abandoned outside the window.
   */
  useEffect(() => {
    const clear = () => {
      dragDepth.current = 0;
      setDropping(false);
    };
    window.addEventListener('drop', clear, true);
    window.addEventListener('dragend', clear, true);
    return () => {
      window.removeEventListener('drop', clear, true);
      window.removeEventListener('dragend', clear, true);
    };
  }, []);

  const activeDocument = documents.find((d) => d.id === activeDocumentId) ?? null;
  const applyToolToDocument = useApp((s) => s.applyToolToDocument);

  const clearTaskFeedbackTimer = useCallback(() => {
    if (taskFeedbackTimer.current !== null) {
      window.clearTimeout(taskFeedbackTimer.current);
      taskFeedbackTimer.current = null;
    }
  }, []);

  const showTaskFeedback = useCallback(
    (next: TaskFeedback, autoHideMs?: number) => {
      clearTaskFeedbackTimer();
      setTaskFeedback(next);
      if (autoHideMs !== undefined) {
        taskFeedbackTimer.current = window.setTimeout(() => {
          setTaskFeedback(null);
          taskFeedbackTimer.current = null;
        }, autoHideMs);
      }
    },
    [clearTaskFeedbackTimer],
  );

  useEffect(() => () => clearTaskFeedbackTimer(), [clearTaskFeedbackTimer]);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // The engine writes a document back through the main process, so the shell
  // learns a save finished from there rather than from the frame — including
  // the path after Save As, which the tab has to adopt.
  useEffect(() => {
    if (!hasBridge()) return undefined;
    return bridge().onEditorSaved((payload) => engineSaved(payload));
  }, [engineSaved]);

  // The window guards its own close, and `close` is synchronous — it cannot ask
  // the renderer anything at that moment. So the list is pushed up whenever it
  // changes, and the main process already has it when the moment comes.
  useEffect(() => {
    if (!hasBridge()) return;
    void bridge().reportUnsaved(documents.filter(isDirty).map((d) => d.name));
  }, [documents]);

  // Chosen "save all" at the close prompt: write every unsaved document and
  // report whether that worked. A failure keeps the window open.
  useEffect(() => {
    if (!hasBridge()) return undefined;
    return bridge().onSaveAllRequested(async () => {
      const unsaved = useApp.getState().documents.filter(isDirty);
      for (const document of unsaved) {
        try {
          await useApp.getState().saveDocument(document.id);
        } catch (cause) {
          return { saved: false, message: cause instanceof Error ? cause.message : String(cause) };
        }
      }
      // A document that still reads dirty was never written — a Save As the
      // user cancelled, for one. Closing then would drop it.
      const remaining = useApp.getState().documents.filter(isDirty);
      return { saved: remaining.length === 0 };
    });
  }, []);

  // A save that could not be written has to reach the user: the tab still shows
  // unsaved changes, and the disk still holds the older document.
  useEffect(() => {
    if (!hasBridge()) return undefined;
    return bridge().onEditorSaveFailed((payload) => {
      engineSaveFailed(payload);
      setDropError(`${t('officeSaveFailed', locale)}${payload.message}`);
    });
  }, [engineSaveFailed, locale]);

  /** Apply a tool to the active PDF with default params (instant / quick-confirm). */
  const runAgainstActiveDocument = useCallback(
    (picked: ToolMeta, documentId: string) => {
      const title = picked.name[locale];
      showTaskFeedback({ kind: 'working', title });
      void (async () => {
        try {
          const result = await applyToolToDocument(
            documentId,
            picked,
            defaultParams(picked.params),
          );
          const summary = result.summary ? localized(result.summary, locale) : undefined;
          if (result.changedDocument) {
            // Compress etc. put size before/after in summary — surface it, not just the tool name.
            showTaskFeedback(
              { kind: 'ok', title, detail: summary },
              summary ? 4500 : 2200,
            );
            return;
          }
          if (result.files.length > 0) {
            showTaskFeedback({
              kind: 'files',
              title,
              summary,
              files: [...result.files],
            });
            return;
          }
          showTaskFeedback(
            {
              kind: 'ok',
              title: summary ?? title,
            },
            3200,
          );
        } catch (cause) {
          showTaskFeedback({
            kind: 'error',
            title,
            detail: cause instanceof Error ? cause.message : String(cause),
          });
        }
      })();
    },
    [applyToolToDocument, locale, showTaskFeedback],
  );

  /**
   * Where picking a tool goes.
   *
   * With a PDF open: zero-option tools apply immediately; simple default tools
   * ask once; other tools dock as a right task pane; the rest open a window.
   */
  const routeToTool = useCallback(
    (toolId: string, withActiveDocument: boolean) => {
      const picked = uiRegistry.tryGet(toolId);

      if (withActiveDocument && activeDocument && picked && !activeDocument.editor) {
        if (canApplyInstantly(picked)) {
          runAgainstActiveDocument(picked, activeDocument.id);
          return;
        }
        if (canQuickApplyWithConfirm(picked)) {
          setQuickConfirm(picked);
          return;
        }
        if (canOpenFromDocument(picked)) {
          setApplying(picked);
          return;
        }
        setMain({
          name: 'tool',
          toolId,
          initialFile: {
            name: activeDocument.name,
            path: activeDocument.path,
            size: activeDocument.bytes.length,
            mime: 'application/pdf',
            bytes: activeDocument.bytes,
          },
        });
        return;
      }
      setMain({ name: 'tool', toolId });
    },
    [activeDocument, runAgainstActiveDocument],
  );

  const openTool = useCallback(
    (toolId: string) => {
      setPaletteOpen(false);
      routeToTool(toolId, main.name === 'document');
    },
    [main.name, routeToTool],
  );

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteForDocument(false);
  }, []);

  const openWelcome = useCallback(() => setMain({ name: 'welcome' }), []);
  /**
   * Settings is a dialog over whatever is open, not a screen of its own: it is
   * a place you visit for one change and leave, and losing your document view
   * to reach it costs more than the dialog does.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const [pendingAiPrompt, setPendingAiPrompt] = useState<string | null>(null);
  /** Closed for this session, whether or not the user asked to keep it away. */
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  /** Tabs whose engine session the AI closed, waiting for the rewritten file. */
  const [reloadingIds, setReloadingIds] = useState<string[]>([]);
  /** Confirm-mode questions from outside this window, and what was decided. */
  const [officeApprovals, setOfficeApprovals] = useState(EMPTY_APPROVAL_STATE);

  const openAi = useCallback(() => {
    setAiMounted(true);
    setAiOpen(true);
  }, []);

  const handleAiPrompt = useCallback((prompt: string) => {
    setPendingAiPrompt(prompt);
    setAiMounted(true);
    setAiOpen(true);
  }, []);

  /** Opens a file as a document and shows it. */
  const showDocument = useCallback(
    (file: PickedFile) => {
      openDocument(file);
      setMain({ name: 'document' });
    },
    [openDocument],
  );

  /**
   * Opens every document in this window.
   *
   * PDFs are read as bytes for the viewer. Word, Sheet and Slide files open in
   * the embedded engine (no second application). Both become tabs here.
   */
  const settings = useApp((s) => s.settings);
  const darkMode = useApp((s) => s.darkMode);

  const openPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const partitioned = partitionDocumentPaths(paths);
      if (partitioned.office.length > 0) {
        // Deduplicate before the engine is asked for anything. Opening creates
        // a session and copies the document into a work directory; the tab
        // list deduplicates afterwards, so a file that was already open left
        // that session with nothing referencing it and nothing able to close
        // it (issue #29).
        const { open, fresh } = partitionOpenPaths(
          useApp.getState().documents,
          partitioned.office,
        );
        for (const held of open) {
          setActiveDocument(held.id);
          setMain({ name: 'document' });
        }
        // A tab appears only once opening has finished, so the check above
        // cannot see a request that is still in flight. Without this, two
        // overlapping opens of one file each create a session and only one is
        // ever closed.
        const claimed = openGuard.claim(fresh);
        if (claimed.length > 0) {
          setOpening(claimed);
          try {
            // Word, Sheet and Slide documents open in the engine, where they can
            // be edited. PDFs stay with the viewer below. uiTheme keeps the
            // engine chrome in step with Magies / the OS — without it a dark
            // loadmask can sit over a light document.
            const uiTheme = officeUiThemeFor(settings.theme, darkMode);
            for (const file of await bridge().openInEditor(claimed, { uiTheme })) {
              showDocument(file);
            }
          } finally {
            openGuard.release(claimed);
            setOpening([]);
          }
        }
      }
      for (const file of await bridge().readFiles(partitioned.pdf)) showDocument(file);
      if (partitioned.unsupported.length > 0) throw new Error(t('dropNotDocument', locale));
    },
    [darkMode, locale, setActiveDocument, settings.theme, showDocument],
  );

  const openDocumentPicker = useCallback(async () => {
    const paths = await bridge().pickDocumentPaths(false);
    await openPaths(paths);
  }, [openPaths]);

  /**
   * Reopens a path the AI just rewrote, into the tab that already held it.
   *
   * The engine session behind that tab was closed before the write (a stale
   * Editor.bin would otherwise overwrite the result on the next save), so the
   * document has to come back through a new session either way. What must not
   * happen is the tab disappearing in between: with one document open the shell
   * falls back to the welcome screen, and the window looks like it restarted.
   */
  const reopenApplied = useCallback(
    async (absolutePath: string) => {
      const target = normalizeDocumentPath(absolutePath);
      const held = useApp
        .getState()
        .documents.find(
          (doc) => doc.path && normalizeDocumentPath(doc.path) === target && doc.editor,
        );
      try {
        if (!held) {
          // Not open here — the AI wrote a file the user is not looking at.
          await openPaths([absolutePath]);
          return;
        }
        const uiTheme = officeUiThemeFor(settings.theme, darkMode);
        const [file] = await bridge().openInEditor([absolutePath], { uiTheme });
        if (file) useApp.getState().replaceDocument(held.id, file);
      } catch (cause) {
        console.warn('[app] failed to reload AI-updated document:', cause);
      } finally {
        // This document stopped reloading; the others did not. Clearing the
        // whole list took the badge off tabs whose own reload was still in
        // flight, and left them looking ready when they were not (issue #30).
        if (held) setReloadingIds((current) => current.filter((id) => id !== held.id));
      }
    },
    [darkMode, openPaths, settings.theme],
  );

  useEffect(() => {
    if (!hasBridge()) return undefined;
    // One AI request often writes the same file several times over, and each
    // reopen is a full engine boot — so a write waits for the writes to *that
    // file* to stop. Per file: one shared timer meant writing B cancelled A's
    // reload, and A's tab was left holding a session that no longer existed
    // (issue #30).
    const reloads = createReloadQueue({
      settleMs: REOPEN_SETTLE_MS,
      reload: (absolutePath) => void reopenApplied(absolutePath),
    });
    const unsubClosed = bridge().onOfficeSessionsClosed(({ sessions }) => {
      const closedIds = new Set(sessions.map((session) => session.sessionId));
      if (closedIds.size === 0) return;
      // A close means the AI is about to write this file. Anything still
      // waiting on it would reopen the engine over bytes being replaced.
      for (const session of sessions) reloads.cancel(session.path);
      // The tab stays; only its editor is replaced by a "reloading" panel,
      // because the frame behind it no longer has a session to talk to.
      const marked = useApp
        .getState()
        .documents.filter((doc) => doc.editor && closedIds.has(doc.editor.sessionId))
        .map((doc) => doc.id);
      setReloadingIds((current) => [...new Set([...current, ...marked])]);
    });
    const unsubApplied = bridge().onOfficeDocumentApplied(({ path: absolutePath }) => {
      reloads.schedule(absolutePath);
    });
    return () => {
      reloads.cancelAll();
      unsubClosed();
      unsubApplied();
    };
  }, [reopenApplied]);

  /**
   * Confirm-mode questions about Office tools called from outside this window.
   *
   * The subscription lives here rather than in the panel: the panel is lazy, and
   * a request nobody draws is a request that times out denied. Arriving with the
   * panel closed opens it — the answer belongs next to the work being watched.
   */
  const answerOfficeApproval = useCallback((approvalId: string, decision: ApprovalDecision) => {
    setOfficeApprovals((current) => withDecision(current, approvalId, decision, Date.now()));
    void bridge().respondOfficeToolApproval(approvalId, decision).catch(() => {});
  }, []);

  useEffect(() => {
    if (!hasBridge()) return undefined;
    const unsubRequest = bridge().onOfficeToolApproval((request) => {
      setOfficeApprovals((current) => withRequest(current, request));
      setAiMounted(true);
      setAiOpen(true);
    });
    const unsubCleared = bridge().onOfficeToolApprovalCleared(({ approvalId }) => {
      setOfficeApprovals((current) => withTimeout(current, approvalId, Date.now()));
    });
    return () => {
      unsubRequest();
      unsubCleared();
    };
  }, []);

  const createOfficeDocument = useCallback(
    async (kind: OfficeCreateKind) => {
      // The blank document is rendered the same way an opened one is, so the
      // wait — and the reassurance — has to be the same too.
      // The file is created first and then opened the same way any other
      // document is, so a new document and an existing one cannot end up
      // being shown by different things.
      const { created, canceled } = await bridge().createBlankOffice(kind);
      if (canceled || !created) return;

      setOpening([created]);
      try {
        const uiTheme = officeUiThemeFor(settings.theme, darkMode);
        for (const file of await bridge().openInEditor([created], { uiTheme })) {
          showDocument(file);
        }
      } finally {
        setOpening([]);
      }
    },
    [darkMode, settings.theme, showDocument],
  );

  const createPdfDocument = useCallback(async () => {
    showDocument(await createDefaultBlankPdf(bridge()));
  }, [showDocument]);

  const selectTab = useCallback(
    (id: string) => {
      setActiveDocument(id);
      setMain({ name: 'document' });
    },
    [setActiveDocument],
  );

  /** Closing a tab with unsaved changes asks first; a clean one just goes. */
  const requestCloseTab = useCallback(
    (id: string) => {
      const document = documents.find((d) => d.id === id);
      if (document && isDirty(document)) {
        setClosing(document);
        return;
      }
      closeDocument(id);
    },
    [closeDocument, documents],
  );

  /**
   * The view actually shown. Closing the last tab leaves `main` pointing at a
   * document that is gone; deriving the fallback here means the pane can never
   * render empty, where an effect would correct it a render too late.
   */
  const view: MainView = main.name === 'document' && !activeDocument ? { name: 'welcome' } : main;

  // Double-click in Finder / Explorer, Open With, a drop on the dock icon, or a
  // second launch: the main process forwards them all here.
  useEffect(() => {
    if (!hasBridge()) return;
    return bridge().onOpenFiles((paths) => {
      void openPaths(paths).catch((cause) => {
        setDropError(cause instanceof Error ? cause.message : String(cause));
      });
    });
  }, [openPaths]);

  const openToolPickerForDocument = useCallback(() => {
    setPaletteForDocument(true);
    setPaletteOpen(true);
  }, []);

  const onPaletteSelect = useCallback(
    (toolId: string) => {
      const forDocument = paletteForDocument;
      closePalette();
      routeToTool(toolId, forDocument);
    },
    [closePalette, paletteForDocument, routeToTool],
  );

  /**
   * The shell's shortcuts.
   *
   * PDF save / zoom / paging stay on the Viewer. Hosted Office documents have
   * no Viewer, so save and save-as are handled here — only when the open tab
   * is engine-held, so the two sets stay disjoint.
   */
  useEffect(() => {
    const platform = currentPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      const action = matchShortcut(event, platform, { typing: isTypingTarget(event.target) });

      switch (action) {
        case 'open':
          void openDocumentPicker().catch(() => {
            // The picker only fails if the bridge is gone, which the banner says.
          });
          break;
        case 'palette':
          // ⌘K always means "search everything" — drop any document scoping.
          setPaletteForDocument(false);
          setPaletteOpen((open) => !open);
          break;
        case 'dismiss':
          closePalette();
          setDropError('');
          break;
        case 'close':
          // ⌘W closes the open document, then falls back to leaving whatever
          // page you are on. With nothing open it means the window, which is
          // Electron's to handle — so it is deliberately not prevented.
          if (view.name === 'document' && activeDocumentId) requestCloseTab(activeDocumentId);
          else if (view.name !== 'welcome') openWelcome();
          else return;
          break;
        case 'save':
          if (view.name === 'document' && activeDocument?.editor && activeDocumentId) {
            void saveDocument(activeDocumentId);
            break;
          }
          return;
        case 'saveAs':
          if (view.name === 'document' && activeDocument?.editor && activeDocumentId) {
            void saveDocumentAs(activeDocumentId);
            break;
          }
          return;
        default:
          return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeDocument,
    activeDocumentId,
    closePalette,
    view.name,
    openDocumentPicker,
    openWelcome,
    requestCloseTab,
    saveDocument,
    saveDocumentAs,
  ]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={22} className="animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (startupError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md space-y-3 rounded-[var(--radius-card)] border border-[var(--danger)] bg-[var(--danger-soft)] p-5">
          <div className="flex items-center gap-2 text-[var(--danger)]">
            <AlertCircle size={16} />
            <h1 className="text-sm font-semibold">{t('startupFailed', locale)}</h1>
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {t('startupFailedHint', locale)}
          </p>
          <p className="font-mono text-[11px] break-all text-[var(--text-muted)]">{startupError}</p>
        </div>
      </div>
    );
  }

  /**
   * What the engine's file menu asks for. The engine only asks; creating,
   * picking a file and choosing where a copy goes are all the shell's.
   *
   * WPS-style: 另存为 is one path dialog; 输出为PDF is the same with a .pdf name.
   */
  const handleEditorRequest = async (
    document: DocumentState,
    what: 'createNew' | 'open' | 'saveAs' | 'exportPdf',
  ) => {
    if (what === 'open') return openDocumentPicker();
    // Same kind as the open document — derived from the engine type, not the
    // old PDF-preview origin field (hosted tabs do not have one).
    if (what === 'createNew') return createOfficeDocument(officeCreateKind(document));

    // Where it goes is settled first; the save that follows lands there
    // rather than over the original. PDF uses a .pdf default so the filter
    // and LibreOffice path kick in without an engine format gallery.
    // The name is the main process's to derive: it owns `pdfExportName`, and
    // the extension it settles on is what narrows the dialog's type dropdown.
    const target = await bridge().pickEditorSaveAsTarget(
      document.editor?.sessionId ?? '',
      document.name,
      what === 'exportPdf' ? 'pdf' : undefined,
    );
    if (target) await useApp.getState().requestEngineSave(document.id);
    return undefined;
  };

  /**
   * The engine's "Save copy as" (另存副本为).
   *
   * By the time this runs the engine has already converted and uploaded the
   * file. Writing it is a disk write of those bytes — not another engine save,
   * which would try to treat a PDF as Editor.bin and fail silently.
   */
  const handleEditorExport = async (document: DocumentState, title: string) => {
    if (!document.editor) return;
    await bridge().saveEditorExport(document.editor.sessionId, title || document.name);
  };

  const tool = view.name === 'tool' ? uiRegistry.tryGet(view.toolId) : undefined;
  // The PDF ribbon belongs to a PDF. An Office document has the engine's own
  // toolbar right below it, and none of these tools apply to what is open —
  // two stacked toolbars where the top one does nothing for the document.
  const officeEditor = view.name === 'document' && Boolean(activeDocument?.editor);
  // PDF has its own WPS-style chrome inside Viewer; the toolbox Ribbon only
  // belongs on tool pages (and the welcome never shows it).
  const pdfDocumentOpen = view.name === 'document' && Boolean(activeDocument && !activeDocument.editor);
  const showRibbon = view.name !== 'welcome' && !officeEditor && !pdfDocumentOpen;

  return (
    <div
      className="flex h-full flex-col"
      // A file dropped anywhere in the window opens, the way it does in an
      // office suite. Tool drop zones stop the event before it reaches here.
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        setDropError('');
        // The renderer only ever sees paths; the main process does the reading.
        const paths = Array.from(e.dataTransfer.files)
          .map((dropped) => bridge().pathForFile(dropped))
          .filter(Boolean);
        if (paths.length === 0) {
          setDropError(t('dropNotDocument', locale));
          return;
        }
        void openPaths(paths).catch((cause) => {
          setDropError(cause instanceof Error ? cause.message : String(cause));
        });
      }}
    >
      <header className="drag-region flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] px-3">
        <div className="w-[68px] shrink-0" />

        <button
          type="button"
          onClick={openWelcome}
          className="no-drag flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-[14.5px] font-semibold tracking-tight transition-colors hover:bg-[var(--surface-hover)]"
        >
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 select-none"
            draggable={false}
          />
          {t('appName', locale)}
        </button>

        {/* WPS-style: document tabs sit in the title bar, not a second strip. */}
        <div className="no-drag min-w-0 flex-1 overflow-hidden">
          <DocumentTabs
            variant="titlebar"
            documents={documents}
            activeId={view.name === 'document' ? activeDocumentId : null}
            onSelect={selectTab}
            onClose={requestCloseTab}
          />
        </div>

        <button
          type="button"
          onClick={() => {
            setAiMounted(true);
            setAiOpen((open) => !open);
          }}
          className="no-drag flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <Bot size={15} />
          {t('aiAssistantShort', locale)}
        </button>

        <button
          type="button"
          onClick={openSettings}
          aria-label={t('settings', locale)}
          className="no-drag shrink-0 rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <Settings size={15} />
        </button>
      </header>

      {!hasBridge() && (
        <div className="flex items-center gap-2 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-2 text-xs text-[var(--danger)]">
          <AlertCircle size={13} className="shrink-0" />
          {t('bridgeMissing', locale)}
        </div>
      )}

      {showRibbon && (
        <Ribbon
          onSelectTool={openTool}
          onOpenSearch={() => setPaletteOpen(true)}
          onDocument={view.name === 'document'}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 w-0 min-w-0 flex-1 flex-col">
          <main
            className={clsx(
              'min-h-0 flex-1 bg-[var(--surface-app)]',
              view.name === 'document' ? 'overflow-hidden' : 'overflow-y-auto',
            )}
          >
            {/* One boundary for every lazily-loaded screen below. */}
            <Suspense fallback={<ScreenFallback />}>
            {/*
              Office engines stay mounted for every open tab. Switching only
              toggles visibility — remounting the iframe reloads the whole
              editor (fonts, sdkjs, document) and is far too slow for tab flips.
            */}
            {documents.map((doc) => {
              if (!doc.editor) return null;
              const active = view.name === 'document' && doc.id === activeDocumentId;
              return (
                <div
                  key={doc.id}
                  className={clsx('h-full w-full', active ? 'block' : 'hidden')}
                  // Inactive editors stay in the tree so their frames keep state.
                  aria-hidden={!active}
                >
                  {reloadingIds.includes(doc.id) ? (
                    /* Its engine session is gone: the frame has nothing left to
                       talk to, so it is replaced rather than left looking live. */
                    <div
                      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[var(--bg)]"
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2 size={24} className="animate-spin text-[var(--accent)]" />
                      <p className="text-sm font-medium">{t('officeApplyingAiEdit', locale)}</p>
                      <p className="max-w-sm truncate text-xs text-[var(--text-muted)]">{doc.name}</p>
                    </div>
                  ) : (
                  <OfficeEditor
                    document={doc}
                    onModifiedChange={(modified) => {
                      setEngineModified(doc.id, modified);
                      // The main process refuses AI writes to a dirty document,
                      // so it has to hear about the edit as it happens.
                      if (doc.editor && hasBridge()) {
                        void bridge()
                          .setEditorModified(doc.editor.sessionId, modified)
                          .catch(() => {});
                      }
                    }}
                    saveRequestedAt={
                      engineSaveRequest?.id === doc.id ? engineSaveRequest.at : 0
                    }
                    onRequest={(what) => void handleEditorRequest(doc, what)}
                    onExportReady={(title) => void handleEditorExport(doc, title)}
                  />
                  )}
                </div>
              );
            })}

            {view.name === 'document' && activeDocument && !activeDocument.editor && (
              /* Keyed by document id so switching tabs remounts the viewer's
                 own view state — scroll, zoom, mode — per document, while the
                 bytes and history stay in the store. */
              <Viewer
                key={activeDocument.id}
                document={activeDocument}
                onChooseTool={openToolPickerForDocument}
                onRunTool={(toolId) => openTool(toolId)}
                onOpenDocument={() => void openDocumentPicker()}
                onOpenRecent={(path) => void openPaths([path])}
                onOpenSettings={openSettings}
                onAiPrompt={handleAiPrompt}
              />
            )}

            {/* Keep the start centre under tool dialogs so closing feels like
                dismissing a WPS window, not navigating away from a full page. */}
            {(view.name === 'welcome' || view.name === 'tool') && (
              <Home
                onOpenTool={openTool}
                onOpenDocument={openDocumentPicker}
                onCreateOffice={createOfficeDocument}
                onCreatePdf={createPdfDocument}
                onOpenRecent={(path) => openPaths([path])}
                onOpenAi={openAi}
              />
            )}
            </Suspense>
          </main>
        </div>

        {aiMounted && (
          <Suspense fallback={null}>
            <AIChatPanel
              open={aiOpen}
              locale={locale}
              activeDocument={activeDocument}
              pendingPrompt={pendingAiPrompt}
              onClearPendingPrompt={() => setPendingAiPrompt(null)}
              onClose={() => setAiOpen(false)}
              onOpenSettings={() => {
                setAiOpen(false);
                openSettings();
              }}
              onPreviewFile={showDocument}
              onOpenPaths={(paths) => { void openPaths(paths); }}
              officeApprovals={officeApprovals.pending}
              officeApprovalRecords={officeApprovals.records}
              onAnswerOfficeApproval={answerOfficeApproval}
            />
          </Suspense>
        )}
      </div>

      {view.name === 'tool' && tool && (
        <Suspense fallback={null}>
          {tool.id === 'advanced.pipeline' ? (
            <PipelinePage key={tool.id} tool={tool} onBack={openWelcome} />
          ) : tool.id === 'advanced.batch' ? (
            <BatchPage key={tool.id} tool={tool} onBack={openWelcome} />
          ) : tool.id === 'security.add-signature' ? (
            <SignPage key={tool.id} tool={tool} onBack={openWelcome} />
          ) : (
            <ToolPage
              key={tool.id}
              tool={tool}
              onBack={openWelcome}
              initialFile={view.initialFile}
              onPreviewFile={showDocument}
            />
          )}
        </Suspense>
      )}

      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          onSelect={onPaletteSelect}
          filterAccept={paletteForDocument ? '.pdf' : undefined}
        />
      )}
      {applying && activeDocument && (
        <ApplyToolPanel
          key={`${applying.id}|${activeDocument.id}`}
          tool={applying}
          document={activeDocument}
          onClose={() => setApplying(null)}
        />
      )}

      {quickConfirm && activeDocument && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={quickConfirm.name[locale]}
            className="w-full max-w-sm space-y-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-panel)] p-4 shadow-2xl"
          >
            <div className="flex items-start gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
                <ToolIcon name={quickConfirm.icon} size={16} className="text-[var(--accent)]" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[13px] font-semibold">{quickConfirm.name[locale]}</h2>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  {t('pdfTaskQuickBody', locale)}
                </p>
                <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
                  {activeDocument.name}
                </p>
              </div>
              <button
                type="button"
                aria-label={t('close', locale)}
                className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={() => setQuickConfirm(null)}
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setQuickConfirm(null)}>
                {t('cancel', locale)}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const tool = quickConfirm;
                  setQuickConfirm(null);
                  setApplying(tool);
                }}
              >
                {t('pdfTaskMoreOptions', locale)}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const tool = quickConfirm;
                  const docId = activeDocument.id;
                  setQuickConfirm(null);
                  runAgainstActiveDocument(tool, docId);
                }}
              >
                {t('pdfTaskOk', locale)}
              </Button>
            </div>
          </div>
        </div>
      )}

      <UpdatePrompt />

      {dropping && (
        <div
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[var(--accent-soft)]/85 backdrop-blur-sm"
          role="presentation"
        >
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-[var(--accent)] px-10 py-8">
            <Eye size={26} className="text-[var(--accent)]" />
            <p className="text-sm font-medium text-[var(--accent)]">{t('dropToOpen', locale)}</p>
          </div>
        </div>
      )}

      {opening.length > 0 && (
        <div
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[var(--bg)]/80 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-10 py-8 shadow-lg">
            <Loader2 size={24} className="animate-spin text-[var(--accent)]" />
            <p className="max-w-sm truncate text-sm font-medium">
              {t('openingOffice', locale)}
              {/* A new document has no path yet — the label stands alone. */}
              {opening.some((p) => p !== '')
                ? ` ${opening.filter((p) => p !== '').map((p) => p.split(/[/\\]/).pop()).join('、')}`
                : '…'}
            </p>
            <p className="text-xs text-[var(--text-muted)]">{t('openingOfficeHint', locale)}</p>
          </div>
        </div>
      )}

      {dropError && (
        <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)] shadow-lg">
          <AlertCircle size={13} className="shrink-0" />
          <span className="max-w-md truncate">{dropError}</span>
          <button
            type="button"
            aria-label={t('close', locale)}
            onClick={() => setDropError('')}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {taskFeedback && (
        <div
          className={clsx(
            'fixed bottom-4 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-start gap-2 rounded-xl border px-3 py-2.5 shadow-lg',
            taskFeedback.kind === 'error'
              ? 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]'
              : taskFeedback.kind === 'ok'
                ? 'border-[var(--success)] bg-[var(--success-soft)] text-[var(--text-primary)]'
                : 'border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[var(--text-primary)]',
          )}
          role="status"
          aria-live="polite"
        >
          {taskFeedback.kind === 'working' && (
            <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-[var(--accent)]" />
          )}
          {taskFeedback.kind === 'ok' && (
            <Check size={14} className="mt-0.5 shrink-0 text-[var(--success)]" />
          )}
          {taskFeedback.kind === 'error' && (
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
          )}
          {taskFeedback.kind === 'files' && (
            <Save size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium">{taskFeedback.title}</p>
            {taskFeedback.kind === 'working' && (
              <p className="text-[11px] text-[var(--text-muted)]">{t('running', locale)}</p>
            )}
            {taskFeedback.kind === 'ok' && taskFeedback.detail && (
              <p className="mt-0.5 break-words text-[11px] text-[var(--text-secondary)]">
                {taskFeedback.detail}
              </p>
            )}
            {taskFeedback.kind === 'ok' && !taskFeedback.detail && (
              <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                {t('pdfTaskAppliedSaveHint', locale)}
              </p>
            )}
            {taskFeedback.kind === 'error' && (
              <p className="mt-0.5 break-words text-[11px] opacity-90">{taskFeedback.detail}</p>
            )}
            {taskFeedback.kind === 'files' && (
              <>
                {taskFeedback.summary && (
                  <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
                    {taskFeedback.summary}
                  </p>
                )}
                <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                  {taskFeedback.files.length} {t('fileCount', locale)}
                </p>
              </>
            )}
          </div>
          {taskFeedback.kind === 'files' && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                void bridge().saveOutputs(taskFeedback.files).then(() => {
                  showTaskFeedback({ kind: 'ok', title: t('savedTo', locale) }, 2200);
                });
              }}
            >
              <Save size={12} />
              {t('saveAll', locale)}
            </Button>
          )}
          {taskFeedback.kind !== 'working' && (
            <button
              type="button"
              aria-label={t('close', locale)}
              className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={() => {
                clearTaskFeedbackTimer();
                setTaskFeedback(null);
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {closing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay-scrim)] px-4 backdrop-blur-sm"
          role="presentation"
        >
          <div
            className="w-full max-w-sm space-y-4 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-panel)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={t('closeDirtyTitle', locale)}
          >
            <div>
              <h2 className="text-sm font-semibold">{t('closeDirtyTitle', locale)}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                {t('closeDirtyHint', locale).replace('{name}', closing.name)}
              </p>
            </div>
            {/* Save / Don't save / Cancel, in that order — the same three
                choices, and the same wording, an office suite offers. */}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setClosing(null)}>
                {t('cancel', locale)}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  closeDocument(closing.id);
                  setClosing(null);
                }}
              >
                {t('closeDirtyDiscard', locale)}
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  const target = closing.id;
                  setClosing(null);
                  void saveDocument(target)
                    .then(() => closeDocument(target))
                    .catch((cause) => {
                      // A failed save must not take the document with it.
                      setDropError(cause instanceof Error ? cause.message : String(cause));
                    });
                }}
              >
                {t('closeDirtySave', locale)}
              </Button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel onBack={() => setSettingsOpen(false)} />
        </Suspense>
      )}


      {ready && settings.onboardingComplete !== true && !onboardingDismissed && (
        <Suspense fallback={null}>
          <OnboardingWizard
            open={true}
            locale={locale}
            // Closing always ends the tour for this session; the checkbox is
            // what decides whether it also ends for the next launch.
            onClose={(dontShowAgain) => {
              setOnboardingDismissed(true);
              if (dontShowAgain) void updateSettings({ onboardingComplete: true });
            }}
            onOpenSettings={openSettings}
          />
        </Suspense>
      )}
    </div>
  );
}
