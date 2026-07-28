/**
 * Mapping between the rendered page on screen and PDF coordinates.
 *
 * Both pdfjs viewports and MuPDF annotation rects present a page with its
 * origin at the top-left and y increasing downward, and both already fold in
 * the page's `/Rotate`. So the mapping is a plain proportion — and because it
 * works off the displayed box rather than the canvas buffer, the zoom level
 * and the device pixel ratio both cancel out.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A point inside the displayed canvas box, in PDF points. */
export function toPdfPoint(offset: Point, box: Size, page: Size): Point {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
  return {
    x: (offset.x / box.width) * page.width,
    y: (offset.y / box.height) * page.height,
  };
}

/** The rectangle between two drag corners, with width/height always positive. */
export function rectFromDrag(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * Rewrites a rectangle as fractions of the page, so an overlay positioned with
 * it stays put at any zoom without being recomputed.
 */
export function toFractionRect(rect: Rect, page: Size): Rect {
  if (page.width <= 0 || page.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: rect.x / page.width,
    y: rect.y / page.height,
    width: rect.width / page.width,
    height: rect.height / page.height,
  };
}

/** Trims a rectangle to the page, so a drag off the edge cannot redact nothing. */
export function clampRect(rect: Rect, page: Size): Rect {
  const x0 = Math.max(0, Math.min(rect.x, page.width));
  const y0 = Math.max(0, Math.min(rect.y, page.height));
  const x1 = Math.max(0, Math.min(rect.x + rect.width, page.width));
  const y1 = Math.max(0, Math.min(rect.y + rect.height, page.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
