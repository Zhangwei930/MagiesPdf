import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { rectFromDrag, toFractionRect, type Rect, type Size } from './geometry.ts';

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

/**
 * A page's text, as the runs the PDF actually stores. Both the selectable text
 * layer and the search read this, and `textSearch.ts` explains why the runs
 * matter rather than one joined string.
 */
export async function getPageTextItems(
  doc: PdfDocumentHandle,
  pageNumber: number,
): Promise<string[]> {
  const content = await (await doc.getPage(pageNumber)).getTextContent();
  return content.items.map((item) => ('str' in item ? item.str : ''));
}

/**
 * Draws the invisible, selectable text over a rendered page.
 *
 * A canvas is a picture: without this the text cannot be selected, copied or
 * found, which is most of what a reader is for. pdf.js positions transparent
 * spans to match the glyphs, and the browser's own selection does the rest.
 *
 * Returns the span per text run, in the same order as `getPageTextItems`, so a
 * search hit can be highlighted by its run index.
 */
export async function renderTextLayer(
  doc: PdfDocumentHandle,
  pageNumber: number,
  container: HTMLElement,
  scale: number,
): Promise<HTMLElement[]> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  container.replaceChildren();
  const layer = new pdfjsLib.TextLayer({
    textContentSource: await page.getTextContent(),
    container,
    viewport,
  });
  await layer.render();
  return layer.textDivs;
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
 * Every page's size in PDF points, with `/Rotate` already applied — the input
 * the continuous-scroll layout needs before it can draw anything.
 */
export async function getPageSizes(doc: PdfDocumentHandle): Promise<Size[]> {
  const sizes: Size[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const viewport = (await doc.getPage(pageNumber)).getViewport({ scale: 1 });
    sizes.push({ width: viewport.width, height: viewport.height });
  }
  return sizes;
}

/**
 * Draws a page and reports its size in PDF points (rotation already applied),
 * which is what maps a click on the canvas back to a place in the document.
 *
 * The page is drawn offscreen and blitted in one go. Assigning to `canvas.width`
 * clears it, so rendering straight onto the visible canvas makes every re-render
 * — a zoom, or the reload after an edit — flash blank first.
 *
 * `dpr` multiplies the pixel buffer without changing the layout size, which is
 * what keeps text crisp on a retina display. Coordinate mapping is unaffected:
 * clicks are measured against the displayed box, so the ratio cancels out.
 *
 * `isStale` is consulted once the drawing is done. Zooming fires renders faster
 * than they finish, and without this the last one to *complete* wins — leaving
 * the page stuck at a scale the reader has already zoomed past.
 */
export async function renderPageToCanvas(
  doc: PdfDocumentHandle,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number,
  dpr = 1,
  isStale: () => boolean = () => false,
): Promise<Size> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: scale * dpr });
  const unscaled = page.getViewport({ scale: 1 });

  const buffer = document.createElement('canvas');
  buffer.width = Math.max(1, Math.floor(viewport.width));
  buffer.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvas: buffer, viewport }).promise;

  if (isStale()) return { width: unscaled.width, height: unscaled.height };

  canvas.width = buffer.width;
  canvas.height = buffer.height;
  canvas.style.width = `${buffer.width / dpr}px`;
  canvas.style.height = `${buffer.height / dpr}px`;
  canvas.getContext('2d')?.drawImage(buffer, 0, 0);

  return { width: unscaled.width, height: unscaled.height };
}
