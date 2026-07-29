/**
 * Finding text across the runs a PDF actually stores.
 *
 * pdf.js hands back a page's text as a list of runs, and a PDF is free to split
 * a single word across several of them — "in" + "voice" is ordinary output, not
 * a broken file. So searching run by run would miss most of what people look
 * for. The runs are joined into one string, the search happens there, and each
 * hit is mapped back to the runs it covers, which is what the viewer needs in
 * order to highlight it.
 */

/** A hit, as the span of runs it covers. Both ends are inclusive. */
export interface ItemRange {
  firstItem: number;
  lastItem: number;
}

/** The runs joined exactly as `findInItems` sees them. */
export function pageText(items: readonly string[]): string {
  return items.join('');
}

export function findInItems(items: readonly string[], query: string): ItemRange[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];

  const haystack = pageText(items).toLowerCase();
  if (haystack === '') return [];

  // Where each run starts in the joined string, so a hit can be mapped back.
  const starts: number[] = [];
  let offset = 0;
  for (const item of items) {
    starts.push(offset);
    offset += item.length;
  }

  const found: ItemRange[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;

    const end = at + needle.length;

    let firstItem = -1;
    let lastItem = -1;
    for (let index = 0; index < items.length; index += 1) {
      const length = items[index]?.length ?? 0;
      // An empty run has no extent, so it can never be part of a hit.
      if (length === 0) continue;

      const itemStart = starts[index] ?? 0;
      if (itemStart < end && itemStart + length > at) {
        if (firstItem < 0) firstItem = index;
        lastItem = index;
      }
    }
    if (firstItem >= 0) found.push({ firstItem, lastItem });
    // Advance past this hit so "aa" in "aaaa" is two matches, not three.
    from = at + needle.length;
  }
  return found;
}

/** Steps to the next or previous match, wrapping the way a browser find does. */
export function nextMatchIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + direction + total) % total;
}
