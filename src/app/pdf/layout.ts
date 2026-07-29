import type { Size } from './geometry.ts';

/**
 * Layout maths for the continuous-scroll viewer.
 *
 * The viewer stacks every page in one scroll column and only draws the ones
 * near the viewport. All of that is plain arithmetic over page sizes, so it
 * lives here rather than in the component — where it would be untestable and
 * would be recomputed inside render.
 *
 * Every length in this module is CSS pixels at the current scale, except the
 * page sizes handed in, which are unscaled PDF points.
 */

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 6;

/** Vertical space between two pages, in CSS pixels. */
export const PAGE_GAP = 16;

/** Breathing room around the page inside the scroll area, in CSS pixels. */
export const PAGE_PADDING = 24;

/** One press of ⌘+ / ⌘-. Geometric, so every press changes the size equally. */
const ZOOM_FACTOR = 1.2;

export function clampScale(scale: number): number {
  if (Number.isNaN(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The top of every page in the scroll column, followed by the column's total
 * height — so the result always has one more entry than there are pages, and
 * `offsets[n] .. offsets[n + 1] - gap` is page `n + 1`'s band.
 */
export function pageOffsets(sizes: Size[], scale: number, gap: number): number[] {
  const offsets = [0];
  let top = 0;
  sizes.forEach((size, index) => {
    top += size.height * scale;
    // The gap sits between pages, so the last one does not get a trailing one.
    if (index < sizes.length - 1) top += gap;
    offsets.push(top);
  });
  return offsets;
}

/** How much of page `n` (1-based) is inside the band `top..bottom`. */
function overlap(offsets: number[], n: number, top: number, bottom: number): number {
  const pageTop = offsets[n - 1] ?? 0;
  // The band ends where the next page starts, minus the gap — but the last
  // entry is the total height, which already excludes a trailing gap.
  const pageBottom = offsets[n] ?? pageTop;
  return Math.max(0, Math.min(bottom, pageBottom) - Math.max(top, pageTop));
}

/**
 * The pages worth drawing: those the viewport straddles, plus `overscan` pages
 * on each side so a scroll does not reveal blank paper before it catches up.
 *
 * Returned 1-based and inclusive; an empty document gives `first > last`, which
 * makes the caller's loop do nothing without a special case.
 */
export function visibleRange(
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): { first: number; last: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { first: 1, last: 0 };

  // Rubber-band overscroll reports a negative scrollTop on macOS.
  const top = Math.max(0, scrollTop);
  const bottom = top + viewportHeight;

  let first = count;
  let last = 1;
  for (let n = 1; n <= count; n += 1) {
    if (overlap(offsets, n, top, bottom) > 0) {
      first = Math.min(first, n);
      last = Math.max(last, n);
    }
  }

  return {
    first: Math.max(1, first - overscan),
    last: Math.min(count, last + overscan),
  };
}

/**
 * The page a reader would call "the one I'm on": whichever fills most of the
 * viewport. Ties go to the earlier page, so scrolling down only advances the
 * counter once the next page has genuinely taken over.
 */
export function pageAtOffset(offsets: number[], scrollTop: number, viewportHeight: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 1;

  const top = Math.max(0, scrollTop);
  const bottom = top + viewportHeight;

  let best = 1;
  let bestVisible = -1;
  for (let n = 1; n <= count; n += 1) {
    const visible = overlap(offsets, n, top, bottom);
    if (visible > bestVisible) {
      best = n;
      bestVisible = visible;
    }
  }
  return best;
}

/** Where to scroll so page `n` starts at the top of the viewport. */
export function scrollTopForPage(offsets: number[], page: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  return offsets[Math.min(count, Math.max(1, page)) - 1] ?? 0;
}

/**
 * The scale that fits a page to the viewport: `width` lets a tall page scroll,
 * `page` shows all of it at once.
 */
export function fitScale(
  size: Size,
  viewport: Size,
  mode: 'width' | 'page',
  padding: number,
): number {
  if (size.width <= 0 || size.height <= 0) return 1;

  const byWidth = (viewport.width - padding * 2) / size.width;
  if (mode === 'width') return clampScale(byWidth);
  return clampScale(Math.min(byWidth, (viewport.height - padding * 2) / size.height));
}

/** One zoom press. `direction` is +1 to enlarge, -1 to shrink. */
export function zoomStep(scale: number, direction: 1 | -1): number {
  return clampScale(direction > 0 ? scale * ZOOM_FACTOR : scale / ZOOM_FACTOR);
}

/**
 * Where to scroll after a zoom so the document point under the cursor stays
 * under the cursor — the difference between zooming and being thrown across
 * the document.
 *
 * `anchorY` is the cursor's distance from the top of the viewport.
 */
export function scrollTopAfterZoom(
  scrollTop: number,
  anchorY: number,
  oldScale: number,
  newScale: number,
): number {
  if (oldScale <= 0) return scrollTop;
  const documentY = (scrollTop + anchorY) / oldScale;
  return Math.max(0, documentY * newScale - anchorY);
}
