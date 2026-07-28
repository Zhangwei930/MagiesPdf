import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { rectFromDrag, toFractionRect, type Rect } from './geometry.ts';

/**
 * Read-only page rendering for the in-app viewer. This is the renderer's own
 * pdfjs-dist, unrelated to the MuPDF/pdf-lib engine in src/core — the viewer
 * only ever draws pages to a canvas, never writes a PDF.
 *
 * This module is only reachable through the lazy-loaded Viewer component, so
 * pdfjs-dist and its worker land in their own chunk instead of the main bundle.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export interface PdfDocumentHandle {
  numPages: number;
  getPage(pageNumber: number): Promise<pdfjsLib.PDFPageProxy>;
  destroy(): void;
}

export async function loadPdfDocument(
  bytes: Uint8Array,
  password = '',
): Promise<PdfDocumentHandle> {
  // pdfjs takes ownership of the buffer it's given; hand it a copy so the
  // caller's bytes (still referenced elsewhere, e.g. for a tool run) survive.
  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice(), password });
  const proxy = await loadingTask.promise;
  return {
    numPages: proxy.numPages,
    getPage: (pageNumber) => proxy.getPage(pageNumber),
    destroy: () => void loadingTask.destroy(),
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Narrows an untyped pdfjs `[x0,y0,x1,y1]` to real numbers, or null. */
function cornersOf(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [a, b, c, d] = value as unknown[];
  return finite(a) && finite(b) && finite(c) && finite(d) ? [a, b, c, d] : null;
}

/** Narrows an untyped pdfjs `[x,y]` to real numbers, or null. */
function pointOf(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [a, b] = value as unknown[];
  return finite(a) && finite(b) ? [a, b] : null;
}

export interface FormFieldBox {
  name: string;
  /** pdfjs field types: Tx text, Btn button/checkbox/radio, Ch choice, Sig signature. */
  type: string;
  value: string;
  readOnly: boolean;
  checkbox: boolean;
  /** Position on the displayed page, as fractions of it. */
  box: Rect;
}

/**
 * Reads the interactive form widgets on a page, positioned for an overlay.
 *
 * Widget rects come in raw PDF user space; the page's own viewport converts
 * them, so a rotated page needs no special handling here.
 */
export async function getFormFields(
  doc: PdfDocumentHandle,
  pageNumber: number,
): Promise<FormFieldBox[]> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const annotations = await page.getAnnotations();

  const fields: FormFieldBox[] = [];
  for (const raw of annotations) {
    const annotation = raw as {
      subtype?: string;
      fieldName?: string;
      fieldType?: string;
      fieldValue?: unknown;
      readOnly?: boolean;
      checkBox?: boolean;
      radioButton?: boolean;
      rect?: number[];
    };
    if (annotation.subtype !== 'Widget') continue;

    const name = annotation.fieldName ?? '';
    // Everything below comes from an untyped pdfjs object, so the shape is
    // checked rather than asserted — a malformed widget is skipped, not drawn
    // at a nonsense position.
    const corners = cornersOf(annotation.rect);
    if (name === '' || !corners) continue;

    const start = pointOf(viewport.convertToViewportPoint(corners[0], corners[1]));
    const end = pointOf(viewport.convertToViewportPoint(corners[2], corners[3]));
    if (!start || !end) continue;

    const [x1, y1] = start;
    const [x2, y2] = end;

    fields.push({
      name,
      type: annotation.fieldType ?? 'unknown',
      value: annotation.fieldValue == null ? '' : String(annotation.fieldValue),
      readOnly: annotation.readOnly === true,
      checkbox: annotation.checkBox === true || annotation.radioButton === true,
      box: toFractionRect(rectFromDrag({ x: x1, y: y1 }, { x: x2, y: y2 }), {
        width: viewport.width,
        height: viewport.height,
      }),
    });
  }
  return fields;
}

/**
 * Draws a page and reports its size in PDF points (rotation already applied),
 * which is what maps a click on the canvas back to a place in the document.
 */
export async function renderPageToCanvas(
  doc: PdfDocumentHandle,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number,
): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvas, viewport }).promise;
  const unscaled = page.getViewport({ scale: 1 });
  return { width: unscaled.width, height: unscaled.height };
}
