import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectionOnPages, type RenderedPage, type ViewportRect } from './selectionGeometry.ts';

/** Two A4 pages stacked, drawn at 2× and scrolled so page 1 starts at y = 100. */
const pages: RenderedPage[] = [
  { pageNumber: 1, left: 40, top: 100, width: 1190, height: 1684 },
  { pageNumber: 2, left: 40, top: 1800, width: 1190, height: 1684 },
];
const SCALE = 2;

const line = (over: Partial<ViewportRect> = {}): ViewportRect => ({
  left: 100,
  top: 200,
  width: 240,
  height: 28,
  ...over,
});

describe('a text selection, in the coordinates a page is measured in', () => {
  it('says which page a line is on and where on it', () => {
    const [found] = selectionOnPages([line()], pages, SCALE);

    assert.equal(found?.pageNumber, 1);
    // 100 - 40 = 60 viewport px in from the left; at 2× that is 30 page points.
    assert.deepEqual(found?.rects, [{ x: 30, y: 50, width: 120, height: 14 }]);
  });

  it('keeps every line of a selection that spans lines', () => {
    const [found] = selectionOnPages(
      [line(), line({ top: 232 }), line({ top: 264, width: 120 })],
      pages,
      SCALE,
    );
    assert.equal(found?.rects.length, 3);
  });

  /**
   * Dragging across a page break is one selection and two highlights. Putting
   * both halves on one page would draw a mark over blank paper.
   */
  it('splits a selection that crosses a page break', () => {
    const found = selectionOnPages(
      [line({ top: 1700 }), line({ top: 1900 })],
      pages,
      SCALE,
    );

    assert.deepEqual(found.map((entry) => entry.pageNumber), [1, 2]);
    assert.equal(found[0]?.rects.length, 1);
    assert.equal(found[1]?.rects.length, 1);
    // Measured from its own page's top, not from the document's.
    assert.equal(found[1]?.rects[0]?.y, 50);
  });

  /**
   * A line that overhangs the edge belongs to the page it is mostly on, not to
   * whichever page happens to be checked first.
   */
  it('assigns a rectangle by its centre, not by its edge', () => {
    // Page 1 ends at 1784; this line starts above it and hangs past the edge,
    // but its centre (1775) is still on page 1.
    const overhanging = line({ top: 1750, height: 50 });
    const [found] = selectionOnPages([overhanging], pages, SCALE);
    assert.equal(found?.pageNumber, 1, 'its centre is still on page 1');
  });

  it('drops the caret and the gaps between words', () => {
    assert.deepEqual(selectionOnPages([line({ width: 0 }), line({ height: 0 })], pages, SCALE), []);
  });

  it('drops a rectangle that is not on any page', () => {
    assert.deepEqual(selectionOnPages([line({ top: 5000 })], pages, SCALE), []);
  });

  it('answers nothing rather than dividing by zero', () => {
    assert.deepEqual(selectionOnPages([line()], pages, 0), []);
  });

  it('reports pages in order, however the rectangles arrived', () => {
    const found = selectionOnPages([line({ top: 1900 }), line({ top: 200 })], pages, SCALE);
    assert.deepEqual(found.map((entry) => entry.pageNumber), [1, 2]);
  });
});
