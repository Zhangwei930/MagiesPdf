import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../errors.ts';
import {
  applyPreset,
  bookletOrder,
  duplexSort,
  oddEvenMerge,
  oddEvenSplit,
  reverseOrder,
} from './pageOrders.ts';

/** Every preset is a permutation: no page invented, dropped or duplicated. */
function assertPermutation(order: readonly number[], total: number, label: string) {
  assert.equal(order.length, total, `${label}: wrong length`);
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: total }, (_, i) => i + 1), label);
}

describe('reverseOrder', () => {
  it('reverses', () => {
    assert.deepEqual(reverseOrder(4), [4, 3, 2, 1]);
  });
});

describe('oddEvenSplit', () => {
  it('lists odd pages then even pages', () => {
    assert.deepEqual(oddEvenSplit(6), [1, 3, 5, 2, 4, 6]);
  });

  it('handles an odd total', () => {
    assert.deepEqual(oddEvenSplit(5), [1, 3, 5, 2, 4]);
  });
});

describe('oddEvenMerge', () => {
  it('interleaves the two halves of a fronts-then-backs scan', () => {
    assert.deepEqual(oddEvenMerge(6), [1, 4, 2, 5, 3, 6]);
  });

  it('leaves the odd page out at the end', () => {
    assert.deepEqual(oddEvenMerge(5), [1, 4, 2, 5, 3]);
  });

  it('is the inverse of oddEvenSplit for even totals', () => {
    const total = 8;
    const split = oddEvenSplit(total);
    const restored = oddEvenMerge(total).map((p) => split[p - 1]);
    assert.deepEqual(restored, [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('duplexSort', () => {
  it('interleaves from both ends', () => {
    assert.deepEqual(duplexSort(6), [1, 6, 2, 5, 3, 4]);
  });

  it('does not repeat the middle page of an odd total', () => {
    assert.deepEqual(duplexSort(5), [1, 5, 2, 4, 3]);
  });
});

describe('bookletOrder', () => {
  it('produces saddle-stitch order for a full sheet count', () => {
    assert.deepEqual(bookletOrder(8), [8, 1, 2, 7, 6, 3, 4, 5]);
  });

  it('handles the minimum four-page booklet', () => {
    assert.deepEqual(bookletOrder(4), [4, 1, 2, 3]);
  });

  it('handles a page count that is not a multiple of four', () => {
    assertPermutation(bookletOrder(6), 6, 'booklet(6)');
    assertPermutation(bookletOrder(7), 7, 'booklet(7)');
  });
});

describe('every preset', () => {
  const presets = ['reverse', 'oddEvenSplit', 'oddEvenMerge', 'duplexSort', 'booklet'] as const;

  it('is a permutation for a range of page counts', () => {
    for (const preset of presets) {
      for (const total of [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 17]) {
        assertPermutation(applyPreset(preset, total), total, `${preset}(${total})`);
      }
    }
  });
});

describe('applyPreset', () => {
  it('rejects "custom", which has no implicit order', () => {
    assert.throws(() => applyPreset('custom', 4), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'INVALID_PARAM');
      return true;
    });
  });
});
