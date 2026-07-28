import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampRect, rectFromDrag, toFractionRect, toPdfPoint } from './geometry.ts';

const A4 = { width: 595, height: 842 };

describe('toPdfPoint', () => {
  it('maps the top-left corner to the page origin', () => {
    assert.deepEqual(toPdfPoint({ x: 0, y: 0 }, { width: 300, height: 424 }, A4), { x: 0, y: 0 });
  });

  it('maps the centre of the box to the centre of the page', () => {
    const point = toPdfPoint({ x: 150, y: 212 }, { width: 300, height: 424 }, A4);
    assert.equal(Math.round(point.x), 298);
    assert.equal(Math.round(point.y), 421);
  });

  it('gives the same page point at any zoom, since the box scales with it', () => {
    const small = toPdfPoint({ x: 75, y: 106 }, { width: 300, height: 424 }, A4);
    const large = toPdfPoint({ x: 150, y: 212 }, { width: 600, height: 848 }, A4);
    assert.deepEqual(small, large);
  });

  it('uses the rotated page size it is handed, without re-flipping anything', () => {
    const landscape = { width: 842, height: 595 };
    const point = toPdfPoint({ x: 100, y: 50 }, { width: 200, height: 100 }, landscape);
    assert.deepEqual(point, { x: 421, y: 297.5 });
  });

  it('returns the origin rather than dividing by a zero-sized box', () => {
    assert.deepEqual(toPdfPoint({ x: 5, y: 5 }, { width: 0, height: 0 }, A4), { x: 0, y: 0 });
  });
});

describe('rectFromDrag', () => {
  it('builds a rect when dragging down-right', () => {
    assert.deepEqual(rectFromDrag({ x: 10, y: 20 }, { x: 40, y: 60 }), {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });

  it('normalises a drag that went up-left', () => {
    assert.deepEqual(rectFromDrag({ x: 40, y: 60 }, { x: 10, y: 20 }), {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });

  it('yields a zero-area rect for a click without movement', () => {
    assert.deepEqual(rectFromDrag({ x: 7, y: 7 }, { x: 7, y: 7 }), {
      x: 7,
      y: 7,
      width: 0,
      height: 0,
    });
  });
});

describe('toFractionRect', () => {
  it('turns a page rectangle into fractions of the page', () => {
    assert.deepEqual(
      toFractionRect({ x: 297.5, y: 421, width: 297.5, height: 421 }, A4),
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    );
  });

  it('maps a full-page rectangle to the whole unit square', () => {
    assert.deepEqual(toFractionRect({ x: 0, y: 0, width: 595, height: 842 }, A4), {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it('returns an empty rect rather than dividing by a zero-sized page', () => {
    assert.deepEqual(toFractionRect({ x: 1, y: 2, width: 3, height: 4 }, { width: 0, height: 0 }), {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('clampRect', () => {
  it('leaves a rect that already fits alone', () => {
    const rect = { x: 10, y: 10, width: 100, height: 100 };
    assert.deepEqual(clampRect(rect, A4), rect);
  });

  it('trims a rect that runs off the right and bottom edges', () => {
    assert.deepEqual(clampRect({ x: 500, y: 800, width: 300, height: 300 }, A4), {
      x: 500,
      y: 800,
      width: 95,
      height: 42,
    });
  });

  it('trims a rect that starts off the top-left', () => {
    assert.deepEqual(clampRect({ x: -50, y: -20, width: 100, height: 100 }, A4), {
      x: 0,
      y: 0,
      width: 50,
      height: 80,
    });
  });

  it('collapses a rect entirely outside the page to zero area', () => {
    const clamped = clampRect({ x: 900, y: 900, width: 50, height: 50 }, A4);
    assert.equal(clamped.width, 0);
    assert.equal(clamped.height, 0);
  });
});
