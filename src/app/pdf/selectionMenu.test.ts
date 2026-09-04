import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { selectionMenuPosition } from './selectionMenu.ts';

/** A viewport 800 wide and 600 tall, with the scroll container filling it. */
const container = { left: 0, top: 0, width: 800, height: 600 };

describe('selectionMenuPosition', () => {
  it('centres the menu above a selection on the first screen', () => {
    const at = selectionMenuPosition({
      selection: { left: 300, right: 500, top: 200, bottom: 220, width: 200 },
      container,
      scroll: { left: 0, top: 0 },
    });

    assert.deepEqual(at, { x: 400, y: 156 });
  });

  /**
   * The menu is positioned inside the scrolled content, not inside the
   * viewport, so the scroll offset is part of its coordinate. Without it the
   * menu is placed where the selection *would* be if the document had never
   * been scrolled — off screen, above the visible page. See issue #33.
   */
  it('adds the scroll offset, so a selection on a later page is not placed off screen', () => {
    const at = selectionMenuPosition({
      selection: { left: 300, right: 500, top: 200, bottom: 220, width: 200 },
      container,
      scroll: { left: 0, top: 5000 },
    });

    assert.equal(at?.y, 5156, 'the menu belongs 5000px down the content');
  });

  it('adds a horizontal scroll offset too', () => {
    const at = selectionMenuPosition({
      selection: { left: 300, right: 500, top: 200, bottom: 220, width: 200 },
      container,
      scroll: { left: 250, top: 0 },
    });

    assert.equal(at?.x, 650);
  });

  it('keeps the menu inside the visible width at either edge', () => {
    const nearLeft = selectionMenuPosition({
      selection: { left: 0, right: 20, top: 300, bottom: 320, width: 20 },
      container,
      scroll: { left: 400, top: 100 },
    });
    assert.equal(nearLeft?.x, 520, 'clamped to 120 in from the left of the visible area');

    const nearRight = selectionMenuPosition({
      selection: { left: 780, right: 800, top: 300, bottom: 320, width: 20 },
      container,
      scroll: { left: 400, top: 100 },
    });
    assert.equal(nearRight?.x, 1080, 'clamped to 120 in from the right of the visible area');
  });

  it('keeps the menu below the top of the visible area', () => {
    const at = selectionMenuPosition({
      selection: { left: 300, right: 500, top: 5, bottom: 25, width: 200 },
      container,
      scroll: { left: 0, top: 2000 },
    });

    assert.equal(at?.y, 2040, 'never above 40px into the visible area');
  });

  it('hides the menu when the selection has scrolled out of view', () => {
    for (const selection of [
      { left: 300, right: 500, top: -200, bottom: -100, width: 200 },
      { left: 300, right: 500, top: 700, bottom: 800, width: 200 },
      { left: -400, right: -200, top: 300, bottom: 320, width: 200 },
      { left: 900, right: 1100, top: 300, bottom: 320, width: 200 },
    ]) {
      assert.equal(
        selectionMenuPosition({ selection, container, scroll: { left: 0, top: 1000 } }),
        null,
      );
    }
  });

  it('positions against the viewport when there is no scroll container', () => {
    const at = selectionMenuPosition({
      selection: { left: 300, right: 500, top: 200, bottom: 220, width: 200 },
      container: null,
      scroll: { left: 0, top: 0 },
    });

    assert.deepEqual(at, { x: 400, y: 188 });
  });
});
