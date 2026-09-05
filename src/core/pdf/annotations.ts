import type * as mupdf from 'mupdf';
import { saveDocument, withDocumentSync } from './document.ts';

/**
 * Marks the user drew, written into the file as annotations.
 *
 * They go in as `/Highlight` and `/Ink` objects rather than being painted onto
 * the page, so another reader can see them, move them, or take them off — and
 * so the text underneath a highlight is still text. Burning them into the page
 * would look the same in this app and be a different document everywhere else.
 *
 * Coordinates come in the space the viewer draws in: points from the top-left
 * of the page as it is laid out, y downward. PDF user space is the other way
 * up, and where its origin sits depends on the page's own box — which this
 * side can read and the viewer cannot. So the flip happens here, once, next to
 * the page it is about, rather than in every caller.
 */

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface TextHighlight {
  pageNumber: number;
  /** One rectangle per line the selection covers. */
  rects: AnnotationRect[];
  /** `#rrggbb`. */
  color: string;
}

export interface InkStroke {
  pageNumber: number;
  points: AnnotationPoint[];
  /** `#rrggbb`. */
  color: string;
  strokeWidth: number;
}

export interface DocumentAnnotations {
  highlights: TextHighlight[];
  ink: InkStroke[];
}

/**
 * Marks this application wrote, so writing again replaces them instead of
 * stacking a second copy on top of the first.
 *
 * Someone else's annotations are left alone: the document may already carry
 * comments from another reader, and a save here is not permission to remove
 * them.
 */
const AUTHOR = 'MagiesPdf';

/** `#rrggbb` → the 0..1 triple MuPDF wants. Anything unreadable is black. */
function rgb(color: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return [0, 0, 0];
  const value = Number.parseInt(match[1] as string, 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * Viewer space to the space MuPDF's annotation setters take, for one page.
 *
 * They take the page's *displayed* space — origin top-left, y downward, and
 * already rotated — which is the space the viewer draws in. MuPDF does the
 * conversion to PDF user space itself when it writes the annotation. So the
 * only thing to do here is the origin of a page whose box does not start at
 * zero, which cropped scans have.
 *
 * Flipping y here as well put a mark drawn 100pt from the top 742pt from the
 * top, and it was invisible for a while because `getBounds()` reports in that
 * same displayed space: reading the mark back through MuPDF returned the
 * wrong number and compared it against itself. `annotations.test.ts` reads
 * what actually reached the file, with pdf-lib.
 */
function pageSpace(page: mupdf.PDFPage): (x: number, y: number) => [number, number] {
  const [x0, y0] = page.getBounds();
  return (x, y) => [x0 + x, y0 + y];
}

/** A rectangle as the four corners MuPDF expects for a quad, in page space. */
function quadOf(rect: AnnotationRect, toPage: (x: number, y: number) => [number, number]): mupdf.Quad {
  const [left, top] = toPage(rect.x, rect.y);
  const [right, bottom] = toPage(rect.x + rect.width, rect.y + rect.height);
  return [left, top, right, top, left, bottom, right, bottom] as mupdf.Quad;
}

function pagesTouched(annotations: DocumentAnnotations): number[] {
  const pages = new Set<number>();
  for (const mark of annotations.highlights) pages.add(mark.pageNumber);
  for (const stroke of annotations.ink) pages.add(stroke.pageNumber);
  return [...pages].sort((left, right) => left - right);
}

/**
 * Writes the marks into the document and returns the new bytes.
 *
 * Returns the input untouched when there is nothing to write — an unmarked
 * document should not be re-encoded, and re-encoding is not free.
 */
export function writeAnnotations(
  bytes: Uint8Array,
  annotations: DocumentAnnotations,
  password = '',
): Uint8Array {
  const highlights = annotations.highlights.filter((mark) => mark.rects.length > 0);
  const ink = annotations.ink.filter((stroke) => stroke.points.length > 0);
  if (highlights.length === 0 && ink.length === 0) return bytes;

  return withDocumentSync(bytes, password, (doc) => {
    const pageCount = doc.countPages();

    for (const pageNumber of pagesTouched({ highlights, ink })) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) continue;
      const page = doc.loadPage(pageNumber - 1) as mupdf.PDFPage;
      const toPage = pageSpace(page);

      for (const mark of highlights.filter((entry) => entry.pageNumber === pageNumber)) {
        const annotation = page.createAnnotation('Highlight');
        annotation.setAuthor(AUTHOR);
        // No Rect: a highlight's extent *is* its quad points, and MuPDF
        // refuses one ("Highlight annotations have no Rect property").
        annotation.setQuadPoints(mark.rects.map((rect) => quadOf(rect, toPage)));
        annotation.setColor(rgb(mark.color));
        annotation.update();
      }

      for (const stroke of ink.filter((entry) => entry.pageNumber === pageNumber)) {
        const annotation = page.createAnnotation('Ink');
        annotation.setAuthor(AUTHOR);
        annotation.setInkList([
          stroke.points.map((point) => toPage(point.x, point.y) as mupdf.Point),
        ]);
        annotation.setColor(rgb(stroke.color));
        annotation.setBorderWidth(stroke.strokeWidth);
        annotation.update();
      }
    }

    return saveDocument(doc);
  });
}
