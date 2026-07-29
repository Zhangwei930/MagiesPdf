import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitScale,
  pageAtOffset,
  pageOffsets,
  scrollTopAfterZoom,
  scrollTopForPage,
  visibleRange,
  zoomStep,
} from './layout.ts';

const A4 = { width: 600, height: 800 };
const LANDSCAPE = { width: 800, height: 600 };

describe('pageOffsets', () => {
  it('stacks pages with a gap and ends with the total height', () => {
    // Two 800pt-tall pages at scale 1 with a 10px gap: 0, 810, total 1610.
    assert.deepEqual(pageOffsets([A4, A4], 1, 10), [0, 810, 1610]);
  });

  it('scales each page height', () => {
    assert.deepEqual(pageOffsets([A4], 0.5, 10), [0, 400]);
  });

  it('handles mixed page sizes', () => {
    // 800 tall, a 10px gap, then a 600-tall landscape page.
    assert.deepEqual(pageOffsets([A4, LANDSCAPE], 1, 10), [0, 810, 1410]);
  });

  it('gives a single zero entry for an empty document', () => {
    assert.deepEqual(pageOffsets([], 1, 10), [0]);
  });

  it('adds no trailing gap after the last page', () => {
    const offsets = pageOffsets([A4, A4, A4], 1, 10);
    assert.equal(offsets[offsets.length - 1], 800 * 3 + 10 * 2);
  });
});

describe('visibleRange', () => {
  // Three 800px pages, 10px gaps: page tops at 0, 810, 1620; total 2420.
  const offsets = pageOffsets([A4, A4, A4], 1, 10);

  it('returns only the page on screen when overscan is zero', () => {
    assert.deepEqual(visibleRange(offsets, 0, 500, 0), { first: 1, last: 1 });
  });

  it('returns every page the viewport straddles', () => {
    assert.deepEqual(visibleRange(offsets, 700, 500, 0), { first: 1, last: 2 });
  });

  it('widens the range by the overscan on both sides', () => {
    assert.deepEqual(visibleRange(offsets, 810, 500, 1), { first: 1, last: 3 });
  });

  it('never runs past the first or last page', () => {
    assert.deepEqual(visibleRange(offsets, 0, 500, 5), { first: 1, last: 3 });
    assert.deepEqual(visibleRange(offsets, 2400, 500, 5), { first: 1, last: 3 });
  });

  it('clamps a negative scroll position (rubber-band overscroll)', () => {
    assert.deepEqual(visibleRange(offsets, -200, 500, 0), { first: 1, last: 1 });
  });

  it('yields an empty range for an empty document', () => {
    const range = visibleRange(pageOffsets([], 1, 10), 0, 500, 1);
    assert.ok(range.first > range.last, 'an empty range must not iterate');
  });
});

describe('pageAtOffset', () => {
  const offsets = pageOffsets([A4, A4, A4], 1, 10);

  it('reports page 1 at the top', () => {
    assert.equal(pageAtOffset(offsets, 0, 500), 1);
  });

  it('reports the page filling most of the viewport', () => {
    // Viewport 700..1200: page 1 covers 700..800 (100px), page 2 covers 810..1200 (390px).
    assert.equal(pageAtOffset(offsets, 700, 500), 2);
  });

  it('prefers the earlier page when two are equally visible', () => {
    // Page 1 ends at 800, page 2 starts at 810. Viewport 750..860 shows 50px of
    // each, so the tie has to break towards page 1 — the same way Acrobat does.
    assert.equal(pageAtOffset(offsets, 750, 110), 1);
  });

  it('switches to the next page once it dominates the viewport', () => {
    // Viewport 750..910: 50px of page 1 against 100px of page 2.
    assert.equal(pageAtOffset(offsets, 750, 160), 2);
  });

  it('reports the last page when scrolled to the bottom', () => {
    assert.equal(pageAtOffset(offsets, 1920, 500), 3);
  });

  it('returns page 1 for an empty document rather than 0', () => {
    assert.equal(pageAtOffset(pageOffsets([], 1, 10), 0, 500), 1);
  });
});

describe('scrollTopForPage', () => {
  const offsets = pageOffsets([A4, A4, A4], 1, 10);

  it('scrolls to the top of the requested page', () => {
    assert.equal(scrollTopForPage(offsets, 2), 810);
  });

  it('clamps a page number below the first page', () => {
    assert.equal(scrollTopForPage(offsets, 0), 0);
  });

  it('clamps a page number past the last page', () => {
    assert.equal(scrollTopForPage(offsets, 99), 1620);
  });
});

describe('fitScale', () => {
  it('fits the page width inside the viewport, minus padding', () => {
    // (700 - 2*50) / 600 = 1
    assert.equal(fitScale(A4, { width: 700, height: 400 }, 'width', 50), 1);
  });

  it('ignores height in width mode, so a tall page simply scrolls', () => {
    assert.equal(fitScale(A4, { width: 700, height: 100 }, 'width', 50), 1);
  });

  it('fits the whole page in page mode, taking whichever axis binds', () => {
    // width gives 1, height gives (500 - 2*50) / 800 = 0.5 → 0.5 binds.
    assert.equal(fitScale(A4, { width: 700, height: 500 }, 'page', 50), 0.5);
  });

  it('handles a landscape page in page mode', () => {
    // width: (900-100)/800 = 1; height: (700-100)/600 = 1 → 1
    assert.equal(fitScale(LANDSCAPE, { width: 900, height: 700 }, 'page', 50), 1);
  });

  it('clamps rather than returning a useless scale in a tiny viewport', () => {
    assert.equal(fitScale(A4, { width: 60, height: 60 }, 'page', 50), MIN_SCALE);
  });

  it('falls back to 1 for a degenerate page size', () => {
    assert.equal(fitScale({ width: 0, height: 0 }, { width: 700, height: 500 }, 'width', 50), 1);
  });
});

describe('clampScale', () => {
  it('keeps a scale inside the supported range', () => {
    assert.equal(clampScale(1), 1);
    assert.equal(clampScale(0.001), MIN_SCALE);
    assert.equal(clampScale(999), MAX_SCALE);
  });

  it('rejects a non-finite scale instead of poisoning the layout', () => {
    assert.equal(clampScale(Number.NaN), 1);
    assert.equal(clampScale(Number.POSITIVE_INFINITY), MAX_SCALE);
  });
});

describe('zoomStep', () => {
  it('grows and shrinks geometrically so each press feels the same', () => {
    const up = zoomStep(1, 1);
    assert.ok(up > 1);
    assert.ok(Math.abs(zoomStep(up, -1) - 1) < 1e-9, 'one step back returns to where it started');
  });

  it('stops at the range ends instead of overshooting', () => {
    assert.equal(zoomStep(MAX_SCALE, 1), MAX_SCALE);
    assert.equal(zoomStep(MIN_SCALE, -1), MIN_SCALE);
  });
});

describe('scrollTopAfterZoom', () => {
  it('keeps the point under the cursor in place', () => {
    // Cursor 100px down the viewport, content at 200 → document point 300.
    // Doubling the scale puts that point at 600, so it must sit 100px down again.
    assert.equal(scrollTopAfterZoom(200, 100, 1, 2), 500);
  });

  it('is an identity when the scale does not change', () => {
    assert.equal(scrollTopAfterZoom(200, 100, 1.5, 1.5), 200);
  });

  it('never scrolls above the top of the document', () => {
    assert.equal(scrollTopAfterZoom(0, 100, 2, 1), 0);
  });

  it('returns the original position when the old scale is degenerate', () => {
    assert.equal(scrollTopAfterZoom(200, 100, 0, 2), 200);
  });
});
