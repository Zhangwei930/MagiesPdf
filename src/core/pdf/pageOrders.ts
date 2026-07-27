import { ToolError } from '../errors.ts';

/**
 * Page-ordering presets.
 *
 * These are pure `total -> page numbers` functions so they can be unit tested
 * without touching a PDF, and reused by both the reorder tool and the booklet
 * imposition in the N-up tool.
 */

export type OrderPreset =
  | 'custom'
  | 'reverse'
  | 'oddEvenSplit'
  | 'oddEvenMerge'
  | 'duplexSort'
  | 'booklet';

const ascending = (total: number): number[] => Array.from({ length: total }, (_, i) => i + 1);

export function reverseOrder(total: number): number[] {
  return ascending(total).reverse();
}

/** All odd pages first, then all even ones. */
export function oddEvenSplit(total: number): number[] {
  const pages = ascending(total);
  return [...pages.filter((p) => p % 2 === 1), ...pages.filter((p) => p % 2 === 0)];
}

/**
 * Inverse of {@link oddEvenSplit}: interleaves the first half with the second.
 * This is what fixes a document scanned as "all fronts, then all backs".
 * With an odd total the extra page stays at the end.
 */
export function oddEvenMerge(total: number): number[] {
  const half = Math.ceil(total / 2);
  const fronts = ascending(total).slice(0, half);
  const backs = ascending(total).slice(half);

  const merged: number[] = [];
  for (let i = 0; i < half; i += 1) {
    merged.push(fronts[i] as number);
    const back = backs[i];
    if (back !== undefined) merged.push(back);
  }
  return merged;
}

/**
 * Interleaves from both ends: 1, n, 2, n-1, …
 * Fixes a duplex scan where the back sides were fed in reverse.
 */
export function duplexSort(total: number): number[] {
  const order: number[] = [];
  let front = 1;
  let back = total;
  while (front <= back) {
    order.push(front);
    if (front !== back) order.push(back);
    front += 1;
    back -= 1;
  }
  return order;
}

/**
 * Saddle-stitch imposition order: n, 1, 2, n-1, n-2, 3, 4, n-3, …
 *
 * Printed two-up double-sided and folded down the middle, this yields a booklet
 * that reads in order. Padding to a multiple of four is the caller's job — a
 * short final sheet simply omits its missing pages.
 */
export function bookletOrder(total: number): number[] {
  const order: number[] = [];
  let low = 1;
  let high = total;

  // Each pass emits one sheet: the front side (high, low) then the back (low, high).
  // Every push is guarded so a short final sheet just drops its missing slots
  // instead of repeating a page.
  while (low <= high) {
    if (low <= high) order.push(high--);
    if (low <= high) order.push(low++);
    if (low <= high) order.push(low++);
    if (low <= high) order.push(high--);
  }

  return order;
}

export function applyPreset(preset: OrderPreset, total: number): number[] {
  switch (preset) {
    case 'reverse':
      return reverseOrder(total);
    case 'oddEvenSplit':
      return oddEvenSplit(total);
    case 'oddEvenMerge':
      return oddEvenMerge(total);
    case 'duplexSort':
      return duplexSort(total);
    case 'booklet':
      return bookletOrder(total);
    case 'custom':
      throw new ToolError('INVALID_PARAM', 'The custom preset needs an explicit page order', {
        zh: '自定义顺序需要填写页码顺序。',
        en: 'A custom order needs an explicit page sequence.',
      });
  }
}
