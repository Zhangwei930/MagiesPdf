import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../errors.ts';
import { asRotation, displayPointToMedia, displayedSize } from './placement.ts';

/** A4 portrait, the size every fixture uses. */
const MEDIA = { width: 595, height: 842 };

describe('asRotation', () => {
  it('accepts the four quarter turns', () => {
    assert.equal(asRotation(0), 0);
    assert.equal(asRotation(90), 90);
    assert.equal(asRotation(180), 180);
    assert.equal(asRotation(270), 270);
  });

  it('normalises angles outside 0..359', () => {
    assert.equal(asRotation(360), 0);
    assert.equal(asRotation(450), 90);
    assert.equal(asRotation(-90), 270);
  });

  it('rejects an angle that is not a quarter turn', () => {
    assert.throws(() => asRotation(45), (e: unknown) => e instanceof ToolError);
  });
});

describe('displayedSize', () => {
  it('leaves an upright page alone', () => {
    assert.deepEqual(displayedSize(MEDIA, 0), MEDIA);
    assert.deepEqual(displayedSize(MEDIA, 180), MEDIA);
  });

  it('swaps the axes on a quarter turn', () => {
    assert.deepEqual(displayedSize(MEDIA, 90), { width: 842, height: 595 });
    assert.deepEqual(displayedSize(MEDIA, 270), { width: 842, height: 595 });
  });
});

describe('displayPointToMedia', () => {
  it('flips the y axis on an upright page', () => {
    // Top-left of the view is the top-left of the paper: pdf-lib y = height.
    assert.deepEqual(displayPointToMedia({ x: 0, y: 0 }, MEDIA, 0), { x: 0, y: 842 });
    assert.deepEqual(displayPointToMedia({ x: 100, y: 42 }, MEDIA, 0), { x: 100, y: 800 });
  });

  it('maps every corner of a 90° page back to the right paper corner', () => {
    const view = displayedSize(MEDIA, 90); // 842 x 595
    // Viewing a 90°-rotated page, its top-left shows the paper's bottom-left.
    assert.deepEqual(displayPointToMedia({ x: 0, y: 0 }, MEDIA, 90), { x: 0, y: 0 });
    assert.deepEqual(displayPointToMedia({ x: view.width, y: 0 }, MEDIA, 90), { x: 0, y: 842 });
    assert.deepEqual(displayPointToMedia({ x: 0, y: view.height }, MEDIA, 90), { x: 595, y: 0 });
    assert.deepEqual(displayPointToMedia({ x: view.width, y: view.height }, MEDIA, 90), {
      x: 595,
      y: 842,
    });
  });

  it('maps every corner of a 180° page back to the right paper corner', () => {
    assert.deepEqual(displayPointToMedia({ x: 0, y: 0 }, MEDIA, 180), { x: 595, y: 0 });
    assert.deepEqual(displayPointToMedia({ x: 595, y: 842 }, MEDIA, 180), { x: 0, y: 842 });
  });

  it('maps every corner of a 270° page back to the right paper corner', () => {
    const view = displayedSize(MEDIA, 270); // 842 x 595
    assert.deepEqual(displayPointToMedia({ x: 0, y: 0 }, MEDIA, 270), { x: 595, y: 842 });
    assert.deepEqual(displayPointToMedia({ x: view.width, y: view.height }, MEDIA, 270), {
      x: 0,
      y: 0,
    });
  });

  it('keeps the centre of the page at the centre under every rotation', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const view = displayedSize(MEDIA, rotation);
      const centre = displayPointToMedia(
        { x: view.width / 2, y: view.height / 2 },
        MEDIA,
        rotation,
      );
      assert.deepEqual(centre, { x: 297.5, y: 421 }, `rotation ${rotation}`);
    }
  });
});
