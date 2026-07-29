/**
 * Which pages an edit actually changed.
 *
 * Every edit rewrites the whole file, so the document object handed back is a
 * new one and the naive reading is that everything must be drawn again. Usually
 * it must not: rotating page 3 leaves pages 1, 2 and 4 pixel-identical, and
 * redrawing them costs a render and a text-layer layout each, on every click.
 *
 * Each page carries an epoch. A page redraws when its epoch changes, so an edit
 * only has to say which pages it could have affected.
 */

/** Pages the caller could not narrow down. */
export type Invalidation = 'all' | readonly number[];

/**
 * A page and every page after it, 1-based.
 *
 * Deleting or inserting a page shifts everything below it, so the page at a
 * given index is different content from there on even though the edit named one
 * page.
 */
export function pagesFrom(first: number, pageCount: number): number[] {
  const pages: number[] = [];
  for (let page = Math.max(1, first); page <= pageCount; page += 1) pages.push(page);
  return pages;
}

/**
 * The next epoch per page. The array is resized to `pageCount`, so pages an
 * edit removed drop out and pages it added start fresh.
 */
export function bumpEpochs(
  epochs: readonly number[],
  pageCount: number,
  changed: Invalidation,
): number[] {
  const all = changed === 'all';
  const touched = all ? null : new Set(changed);

  const next: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const previous = epochs[page - 1];
    // A page that did not exist before has nothing to reuse, so it starts at 1
    // — which differs from whatever a neighbouring page holds only by accident,
    // and it is compared against its own history, not theirs.
    if (previous === undefined) {
      next.push(1);
      continue;
    }
    next.push(all || touched?.has(page) ? previous + 1 : previous);
  }
  return next;
}
