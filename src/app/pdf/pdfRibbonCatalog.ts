/**
 * WPS-style PDF ribbon: every entry maps to an existing Magies tool id (or a
 * viewer action handled in PdfChrome). Keep this list as the single source of
 * which PDF tools appear in the chrome — ⌘K and tool pages stay on the full
 * catalogue.
 */

export type PdfRibbonTabId =
  | 'home'
  | 'insert'
  | 'edit'
  | 'page'
  | 'annotate'
  | 'convert'
  | 'protect'
  | 'tools';

/** A tool chip that opens the existing Apply / tool flow via `onRunTool`. */
export interface PdfRibbonToolItem {
  kind: 'tool';
  toolId: string;
}

/**
 * Viewer-native controls stay on the Home tab (and a few edit modes). They are
 * not tool ids — PdfChrome renders them with its own handlers.
 */
export type PdfRibbonViewerAction =
  | 'hand'
  | 'select'
  | 'undo'
  | 'redo'
  | 'zoomOut'
  | 'zoomIn'
  | 'zoomActual'
  | 'fitWidth'
  | 'fitPage'
  | 'prevPage'
  | 'nextPage'
  | 'rotatePage'
  | 'layoutSingle'
  | 'layoutContinuous'
  | 'find'
  | 'save'
  | 'saveAs'
  | 'print'
  | 'nightMode'
  | 'modeText'
  | 'modeForm'
  | 'modeStamp'
  | 'modeRedact'
  | 'modeDraw'
  | 'chooseTool';

export interface PdfRibbonActionItem {
  kind: 'action';
  action: PdfRibbonViewerAction;
}

export interface PdfRibbonSepItem {
  kind: 'sep';
}

export type PdfRibbonItem = PdfRibbonToolItem | PdfRibbonActionItem | PdfRibbonSepItem;

export interface PdfRibbonTab {
  id: PdfRibbonTabId;
  /** i18n key in app messages */
  labelKey:
    | 'pdfTabHome'
    | 'pdfTabInsert'
    | 'pdfTabEdit'
    | 'pdfTabPage'
    | 'pdfTabAnnotate'
    | 'pdfTabConvert'
    | 'pdfTabProtect'
    | 'pdfTabTools';
  items: readonly PdfRibbonItem[];
}

const tool = (toolId: string): PdfRibbonToolItem => ({ kind: 'tool', toolId });
const action = (a: PdfRibbonViewerAction): PdfRibbonActionItem => ({ kind: 'action', action: a });
const sep = (): PdfRibbonSepItem => ({ kind: 'sep' });

/**
 * Full PDF ribbon layout. Tool ids must exist in the catalogue; missing ones
 * are skipped at render time so a partial catalog never blanks a tab.
 */
export const PDF_RIBBON_TABS: readonly PdfRibbonTab[] = [
  {
    id: 'home',
    labelKey: 'pdfTabHome',
    items: [
      action('hand'),
      action('select'),
      sep(),
      action('undo'),
      action('redo'),
      sep(),
      action('zoomOut'),
      action('zoomActual'),
      action('zoomIn'),
      action('fitWidth'),
      action('fitPage'),
      sep(),
      action('prevPage'),
      action('nextPage'),
      action('rotatePage'),
      sep(),
      action('layoutSingle'),
      action('layoutContinuous'),
      sep(),
      action('find'),
      sep(),
      action('print'),
      action('nightMode'),
      sep(),
      action('save'),
      action('saveAs'),
      tool('edit.compress'),
      tool('convert.pdf-to-image'),
    ],
  },
  {
    id: 'insert',
    labelKey: 'pdfTabInsert',
    items: [
      tool('edit.add-page-numbers'),
      tool('edit.add-header-footer'),
      tool('security.add-watermark'),
      tool('edit.add-stamp'),
      tool('edit.add-text'),
      tool('edit.add-attachments'),
      tool('edit.bookmarks'),
      tool('security.add-signature'),
    ],
  },
  {
    id: 'edit',
    labelKey: 'pdfTabEdit',
    items: [
      action('modeText'),
      action('modeForm'),
      action('modeStamp'),
      action('modeRedact'),
      sep(),
      tool('edit.fill-form'),
      tool('edit.ocr'),
      tool('edit.repair'),
      tool('edit.grayscale'),
      tool('edit.extract-images'),
      tool('edit.extract-attachments'),
      tool('edit.compare'),
    ],
  },
  {
    id: 'page',
    labelKey: 'pdfTabPage',
    items: [
      tool('organize.rotate'),
      tool('organize.extract-pages'),
      tool('organize.remove-pages'),
      tool('organize.reorder'),
      tool('organize.crop'),
      tool('organize.scale-pages'),
      tool('organize.n-up'),
      tool('organize.single-page'),
      sep(),
      tool('organize.split'),
      tool('organize.merge'),
      tool('organize.split-by-chapters'),
      tool('organize.remove-blank-pages'),
      tool('organize.overlay'),
    ],
  },
  {
    id: 'annotate',
    labelKey: 'pdfTabAnnotate',
    items: [
      action('modeRedact'),
      action('modeStamp'),
      action('modeText'),
      action('modeDraw'),
      sep(),
      tool('security.redact'),
      tool('security.add-signature'),
      tool('security.certificate-sign'),
      tool('security.inspect-signatures'),
      tool('edit.compare'),
    ],
  },
  {
    id: 'convert',
    labelKey: 'pdfTabConvert',
    items: [
      tool('convert.pdf-to-docx'),
      tool('convert.pdf-to-xlsx'),
      tool('convert.pdf-to-pptx'),
      tool('convert.pdf-to-image'),
      tool('convert.pdf-to-text'),
      tool('convert.pdf-to-markdown'),
      tool('convert.pdf-to-html'),
      tool('convert.pdf-to-csv'),
    ],
  },
  {
    id: 'protect',
    labelKey: 'pdfTabProtect',
    items: [
      tool('security.add-password'),
      tool('security.remove-password'),
      tool('security.add-watermark'),
      tool('security.sanitize'),
      tool('security.flatten'),
      tool('security.edit-metadata'),
      tool('security.remove-metadata'),
      tool('security.show-javascript'),
      tool('security.redact'),
    ],
  },
  {
    id: 'tools',
    labelKey: 'pdfTabTools',
    items: [
      tool('edit.compress'),
      tool('edit.get-info'),
      tool('edit.repair'),
      tool('edit.ocr'),
      tool('advanced.batch'),
      tool('advanced.pipeline'),
      action('chooseTool'),
    ],
  },
];

/** All tool ids referenced by the PDF ribbon (for tests / completeness). */
export function pdfRibbonToolIds(): string[] {
  const ids = new Set<string>();
  for (const tab of PDF_RIBBON_TABS) {
    for (const item of tab.items) {
      if (item.kind === 'tool') ids.add(item.toolId);
    }
  }
  return [...ids].sort();
}
