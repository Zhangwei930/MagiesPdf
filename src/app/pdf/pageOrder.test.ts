import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reorderedPages } from './pageOrder.ts';

describe('reorderedPages', () => {
  it('moves a page later, shifting the ones it passes back', () => {
    assert.deepEqual(reorderedPages(4, 1, 3), [2, 3, 1, 4]);
  });

  it('moves a page earlier, shifting the ones it passes forward', () => {
    assert.deepEqual(reorderedPages(4, 3, 1), [3, 1, 2, 4]);
  });

  it('leaves the order alone when a page is dropped on itself', () => {
    assert.deepEqual(reorderedPages(3, 2, 2), [1, 2, 3]);
  });

  it('moves the first page to the very end', () => {
    assert.deepEqual(reorderedPages(3, 1, 3), [2, 3, 1]);
  });

  it('moves the last page to the very front', () => {
    assert.deepEqual(reorderedPages(3, 3, 1), [3, 1, 2]);
  });

  it('keeps every page exactly once, whatever the move', () => {
    const result = reorderedPages(6, 5, 2);
    assert.deepEqual([...result].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  });

  it('returns the untouched order when `from` is out of range', () => {
    assert.deepEqual(reorderedPages(3, 9, 1), [1, 2, 3]);
  });
});
