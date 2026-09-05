/**
 * Where a text selection sits, in the coordinates a page is measured in.
 *
 * The browser reports a selection as a list of rectangles in viewport
 * coordinates — one per line, sometimes several per line — and knows nothing
 * about pages. What writes the annotation needs the opposite: which page each
 * piece is on, and where it sits on that page at scale 1, measured from the
 * top-left with y downward.
 *
 * Both conversions are arithmetic on numbers the caller reads from the DOM, so
 * this is pure and tested without one. That matters more here than elsewhere: a
 * highlight that lands on the wrong page, or half a page off, looks like the
 * feature is broken rather than like a coordinate is wrong.
 */

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A rendered page, in viewport coordinates, as it appears right now. */
export interface RenderedPage extends ViewportRect {
  pageNumber: number;
}

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSelection {
  pageNumber: number;
  rects: PageRect[];
}

/** Rectangles this small are the caret, or the gap between two words. */
const MINIMUM_SIZE = 1;

function centreOf(rect: ViewportRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function contains(page: RenderedPage, point: { x: number; y: number }): boolean {
  return (
    point.x >= page.left &&
    point.x <= page.left + page.width &&
    point.y >= page.top &&
    point.y <= page.top + page.height
  );
}

/**
 * Splits selection rectangles across the pages they fall on.
 *
 * A rectangle belongs to the page its centre is on, so a line that overhangs a
 * page edge by a pixel does not become a mark on the neighbouring page. A
 * selection dragged across a page break produces one entry per page, which is
 * what a reader expects: two pages, two highlights.
 */
export function selectionOnPages(
  clientRects: readonly ViewportRect[],
  pages: readonly RenderedPage[],
  scale: number,
): PageSelection[] {
  if (scale <= 0) return [];

  const byPage = new Map<number, PageRect[]>();
  for (const rect of clientRects) {
    if (rect.width < MINIMUM_SIZE || rect.height < MINIMUM_SIZE) continue;
    const page = pages.find((candidate) => contains(candidate, centreOf(rect)));
    if (!page) continue;

    const list = byPage.get(page.pageNumber) ?? [];
    list.push({
      x: (rect.left - page.left) / scale,
      y: (rect.top - page.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    });
    byPage.set(page.pageNumber, list);
  }

  return [...byPage.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pageNumber, rects]) => ({ pageNumber, rects }));
}
