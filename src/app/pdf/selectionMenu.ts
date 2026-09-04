/**
 * Where the text-selection menu goes.
 *
 * Two coordinate systems meet here and are easy to confuse. A `Range`'s rect
 * and the scroll container's rect are both in viewport coordinates, but the
 * menu is absolutely positioned inside the *scrolled content* — the element
 * that is as tall as the whole document. Subtracting one rect from the other
 * gives a position relative to the visible area, which is the same number only
 * while the document has not been scrolled. Past the first screen the menu
 * lands wherever that selection would have been at scroll zero, which is above
 * the visible page and out of sight.
 *
 * So the scroll offset is part of the answer, not an afterthought.
 *
 * Pure, so it is tested without a DOM.
 */

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

export interface ContainerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SelectionMenuInput {
  /** The selection's bounding rect, in viewport coordinates. */
  selection: Rect;
  /** The scroll container's rect, in viewport coordinates, or null when there is none. */
  container: ContainerRect | null;
  /** How far that container is scrolled. */
  scroll: { left: number; top: number };
}

/** Kept this far from the left and right of the visible area. */
const SIDE_MARGIN = 120;
/** Sits this far above the selection... */
const ABOVE_SELECTION = 44;
/** ...but never higher than this into the visible area. */
const TOP_MARGIN = 40;
/** The gap used when there is no container to clamp against. */
const LOOSE_GAP = 12;

export function selectionMenuPosition(
  input: SelectionMenuInput,
): { x: number; y: number } | null {
  const { selection, container, scroll } = input;

  if (!container) {
    return { x: selection.left + selection.width / 2, y: selection.top - LOOSE_GAP };
  }

  const outOfView =
    selection.bottom < container.top ||
    selection.top > container.top + container.height ||
    selection.right < container.left ||
    selection.left > container.left + container.width;
  if (outOfView) return null;

  // Viewport → content: undo the container's own offset, then add how far it
  // has been scrolled.
  const centre = selection.left + selection.width / 2 - container.left + scroll.left;
  const above = selection.top - container.top - ABOVE_SELECTION + scroll.top;

  // Clamped against the visible area, expressed in content coordinates — which
  // is why each bound carries the scroll offset too.
  return {
    x: Math.max(
      scroll.left + SIDE_MARGIN,
      Math.min(centre, scroll.left + container.width - SIDE_MARGIN),
    ),
    y: Math.max(scroll.top + TOP_MARGIN, above),
  };
}
