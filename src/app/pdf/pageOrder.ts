/**
 * Page order after dragging page `from` onto page `to` (both 1-based).
 *
 * The result is the literal order `organize.reorder` expects for
 * `preset: 'custom'` — every page, listed in its new position.
 */
export function reorderedPages(count: number, from: number, to: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i + 1);
  const [moved] = order.splice(from - 1, 1);
  if (moved === undefined) return order;
  order.splice(to - 1, 0, moved);
  return order;
}
