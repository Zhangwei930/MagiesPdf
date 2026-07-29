import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bumpEpochs, pagesFrom } from './invalidation.ts';

describe('bumpEpochs', () => {
  it('starts every page at the same epoch for a freshly opened document', () => {
    assert.deepEqual(bumpEpochs([], 3, 'all'), [1, 1, 1]);
  });

  it('changes only the page an edit touched', () => {
    const before = bumpEpochs([], 3, 'all');
    const after = bumpEpochs(before, 3, [2]);
    assert.equal(after[0], before[0], 'page 1 is untouched');
    assert.notEqual(after[1], before[1], 'page 2 has to be redrawn');
    assert.equal(after[2], before[2], 'page 3 is untouched');
  });

  it('changes every page when the edit could have touched anything', () => {
    const before = bumpEpochs([], 3, 'all');
    const after = bumpEpochs(before, 3, 'all');
    for (let index = 0; index < 3; index += 1) {
      assert.notEqual(after[index], before[index]);
    }
  });

  it('changes several named pages at once', () => {
    const before = bumpEpochs([], 4, 'all');
    const after = bumpEpochs(before, 4, [1, 4]);
    assert.notEqual(after[0], before[0]);
    assert.equal(after[1], before[1]);
    assert.equal(after[2], before[2]);
    assert.notEqual(after[3], before[3]);
  });

  it('gives a page that did not exist before its own starting epoch', () => {
    const before = bumpEpochs([], 2, 'all');
    const after = bumpEpochs(before, 4, [3, 4]);
    assert.equal(after.length, 4);
    assert.ok(after[2] !== undefined && after[3] !== undefined);
  });

  it('drops the epochs of pages the edit removed', () => {
    const after = bumpEpochs(bumpEpochs([], 5, 'all'), 2, 'all');
    assert.equal(after.length, 2);
  });

  it('ignores page numbers outside the document', () => {
    const before = bumpEpochs([], 2, 'all');
    const after = bumpEpochs(before, 2, [0, 5, -1]);
    assert.deepEqual(after, before);
  });
});

describe('pagesFrom', () => {
  it('lists a page and everything after it', () => {
    // Deleting page 2 of 4 shifts pages 3 and 4 down, so all three change.
    assert.deepEqual(pagesFrom(2, 4), [2, 3, 4]);
  });

  it('lists the whole document when it starts at the first page', () => {
    assert.deepEqual(pagesFrom(1, 3), [1, 2, 3]);
  });

  it('lists just the last page when it starts there', () => {
    assert.deepEqual(pagesFrom(3, 3), [3]);
  });

  it('is empty past the end', () => {
    assert.deepEqual(pagesFrom(9, 3), []);
  });
});
