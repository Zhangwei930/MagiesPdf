import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from './errors.ts';
import { formatPageRange, parsePageRange } from './pageRange.ts';

describe('parsePageRange', () => {
  it('parses a single page', () => {
    assert.deepEqual(parsePageRange('3', 10), [3]);
  });

  it('parses a comma list and keeps written order', () => {
    assert.deepEqual(parsePageRange('3,1,2', 10), [3, 1, 2]);
  });

  it('parses an ascending span', () => {
    assert.deepEqual(parsePageRange('2-5', 10), [2, 3, 4, 5]);
  });

  it('parses a descending span as a reversed run', () => {
    assert.deepEqual(parsePageRange('5-2', 10), [5, 4, 3, 2]);
  });

  it('treats an open end as "through the last page"', () => {
    assert.deepEqual(parsePageRange('8-', 10), [8, 9, 10]);
  });

  it('treats an open start as "from the first page"', () => {
    assert.deepEqual(parsePageRange('-3', 10), [1, 2, 3]);
  });

  it('resolves N to the last page', () => {
    assert.deepEqual(parsePageRange('N', 10), [10]);
    assert.deepEqual(parsePageRange('8-N', 10), [8, 9, 10]);
  });

  it('supports the all/first/last/odd/even keywords', () => {
    assert.deepEqual(parsePageRange('all', 4), [1, 2, 3, 4]);
    assert.deepEqual(parsePageRange('first', 4), [1]);
    assert.deepEqual(parsePageRange('last', 4), [4]);
    assert.deepEqual(parsePageRange('odd', 6), [1, 3, 5]);
    assert.deepEqual(parsePageRange('even', 6), [2, 4, 6]);
  });

  it('supports an every-nth step', () => {
    assert.deepEqual(parsePageRange('1-10/3', 10), [1, 4, 7, 10]);
  });

  it('mixes keywords and spans in one expression', () => {
    assert.deepEqual(parsePageRange('1, 4-6, last', 8), [1, 4, 5, 6, 8]);
  });

  it('is whitespace and case tolerant', () => {
    assert.deepEqual(parsePageRange('  ODD ,  4 - 5 ', 6), [1, 3, 5, 4, 5]);
  });

  it('keeps duplicates so pages can be repeated deliberately', () => {
    assert.deepEqual(parsePageRange('1,1,2', 3), [1, 1, 2]);
  });

  it('rejects an empty expression', () => {
    assert.throws(() => parsePageRange('   ', 10), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'INVALID_PARAM');
      return true;
    });
  });

  it('rejects page 0 and negative pages', () => {
    assert.throws(() => parsePageRange('0', 10), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'PAGE_OUT_OF_RANGE');
      return true;
    });
  });

  it('rejects pages beyond the document', () => {
    assert.throws(() => parsePageRange('11', 10), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'PAGE_OUT_OF_RANGE');
      assert.equal((e.details as { page: number }).page, 11);
      return true;
    });
  });

  it('rejects unparseable tokens', () => {
    assert.throws(() => parsePageRange('1,abc', 10), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'INVALID_PARAM');
      return true;
    });
  });

  it('rejects a non-positive step', () => {
    assert.throws(() => parsePageRange('1-10/0', 10), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'INVALID_PARAM');
      return true;
    });
  });
});

describe('formatPageRange', () => {
  it('collapses consecutive runs', () => {
    assert.equal(formatPageRange([1, 2, 3, 5, 7, 8]), '1-3, 5, 7-8');
  });

  it('sorts and dedupes before collapsing', () => {
    assert.equal(formatPageRange([3, 1, 2, 2]), '1-3');
  });

  it('renders an empty selection as a dash', () => {
    assert.equal(formatPageRange([]), '—');
  });
});
