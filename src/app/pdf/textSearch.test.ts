import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findInItems, nextMatchIndex, pageText } from './textSearch.ts';

describe('findInItems', () => {
  it('finds a match inside a single run', () => {
    assert.deepEqual(findInItems(['hello world'], 'world'), [{ firstItem: 0, lastItem: 0 }]);
  });

  it('finds a match split across runs, which is how PDFs usually store words', () => {
    // A PDF happily emits "in", "voice" as two runs of the same word.
    assert.deepEqual(findInItems(['in', 'voice', ' total'], 'invoice'), [
      { firstItem: 0, lastItem: 1 },
    ]);
  });

  it('spans every run the match touches', () => {
    assert.deepEqual(findInItems(['ab', 'cd', 'ef'], 'bcde'), [{ firstItem: 0, lastItem: 2 }]);
  });

  it('ignores case on both sides', () => {
    assert.deepEqual(findInItems(['Hello World'], 'hello'), [{ firstItem: 0, lastItem: 0 }]);
    assert.deepEqual(findInItems(['hello world'], 'WORLD'), [{ firstItem: 0, lastItem: 0 }]);
  });

  it('reports every occurrence, in reading order', () => {
    assert.deepEqual(findInItems(['a cat and a cat'], 'cat'), [
      { firstItem: 0, lastItem: 0 },
      { firstItem: 0, lastItem: 0 },
    ]);
    assert.deepEqual(findInItems(['cat', ' dog ', 'cat'], 'cat'), [
      { firstItem: 0, lastItem: 0 },
      { firstItem: 2, lastItem: 2 },
    ]);
  });

  it('does not report overlapping matches twice', () => {
    // "aaaa" contains "aa" twice without overlap, not three times.
    assert.equal(findInItems(['aaaa'], 'aa').length, 2);
  });

  it('finds nothing for an empty or whitespace query', () => {
    assert.deepEqual(findInItems(['hello'], ''), []);
    assert.deepEqual(findInItems(['hello'], '   '), []);
  });

  it('finds nothing when the text does not contain it', () => {
    assert.deepEqual(findInItems(['hello'], 'zebra'), []);
  });

  it('survives a page with no text at all', () => {
    assert.deepEqual(findInItems([], 'anything'), []);
    assert.deepEqual(findInItems(['', ''], 'a'), []);
  });

  it('treats a query longer than the page as no match', () => {
    assert.deepEqual(findInItems(['hi'], 'hello there'), []);
  });
});

describe('pageText', () => {
  it('joins the runs the same way the search does, so offsets line up', () => {
    assert.equal(pageText(['in', 'voice']), 'invoice');
  });

  it('is empty for a page with no runs', () => {
    assert.equal(pageText([]), '');
  });
});

describe('nextMatchIndex', () => {
  it('steps forward through the matches', () => {
    assert.equal(nextMatchIndex(0, 3, 1), 1);
    assert.equal(nextMatchIndex(1, 3, 1), 2);
  });

  it('wraps around the end, the way a browser find does', () => {
    assert.equal(nextMatchIndex(2, 3, 1), 0);
  });

  it('steps backwards and wraps the other way', () => {
    assert.equal(nextMatchIndex(0, 3, -1), 2);
    assert.equal(nextMatchIndex(2, 3, -1), 1);
  });

  it('stays at zero when there is nothing to step through', () => {
    assert.equal(nextMatchIndex(0, 0, 1), 0);
    assert.equal(nextMatchIndex(0, 0, -1), 0);
  });
});
