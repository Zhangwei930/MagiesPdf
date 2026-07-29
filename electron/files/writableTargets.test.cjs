const assert = require('node:assert/strict');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');
const {
  LIMIT,
  forgetAll,
  isWritable,
  normalizeTarget,
  remember,
  rememberAll,
} = require('./writableTargets.cjs');

const A = path.resolve('/docs/a.pdf');
const B = path.resolve('/docs/b.pdf');

beforeEach(() => forgetAll());

describe('isWritable', () => {
  it('refuses a path the app has never handled', () => {
    assert.equal(isWritable(A), false);
  });

  it('allows a path the app itself read or wrote', () => {
    remember(A);
    assert.equal(isWritable(A), true);
  });

  it('keeps each path separate', () => {
    remember(A);
    assert.equal(isWritable(B), false);
  });

  it('refuses anything that is not a usable path', () => {
    assert.equal(isWritable(''), false);
    assert.equal(isWritable(null), false);
    assert.equal(isWritable(undefined), false);
    assert.equal(isWritable(42), false);
    assert.equal(isWritable({ toString: () => A }), false);
  });

  it('is not fooled by a path spelled differently', () => {
    remember(A);
    assert.equal(isWritable(path.join(path.dirname(A), '.', 'a.pdf')), true);
    assert.equal(isWritable(path.join(path.dirname(A), 'sub', '..', 'a.pdf')), true);
  });

  it('does not let a traversal reach a sibling it was never given', () => {
    remember(A);
    assert.equal(isWritable(path.join(path.dirname(A), 'sub', '..', 'b.pdf')), false);
  });
});

describe('rememberAll', () => {
  it('records every path in one go and ignores the junk', () => {
    rememberAll([A, '', null, B]);
    assert.equal(isWritable(A), true);
    assert.equal(isWritable(B), true);
  });

  it('survives a non-array', () => {
    rememberAll(null);
    assert.equal(isWritable(A), false);
  });
});

describe('the size cap', () => {
  it('forgets the oldest paths rather than growing without bound', () => {
    for (let n = 0; n < LIMIT + 10; n += 1) remember(path.resolve(`/docs/f${n}.pdf`));

    assert.equal(isWritable(path.resolve('/docs/f0.pdf')), false, 'the oldest is evicted');
    assert.equal(isWritable(path.resolve(`/docs/f${LIMIT + 9}.pdf`)), true, 'the newest is kept');
  });

  it('moves a path back to the front when it is used again, so it is not evicted', () => {
    remember(A);
    for (let n = 0; n < LIMIT - 1; n += 1) remember(path.resolve(`/docs/f${n}.pdf`));
    // A is now the oldest; touching it should make it the newest again.
    remember(A);
    for (let n = 0; n < 5; n += 1) remember(path.resolve(`/docs/g${n}.pdf`));

    assert.equal(isWritable(A), true);
  });
});

describe('normalizeTarget', () => {
  it('leaves case alone where the filesystem is case-sensitive', () => {
    assert.equal(normalizeTarget('/docs/A.pdf', 'linux'), path.resolve('/docs/A.pdf'));
  });

  it('folds case on Windows, where two spellings are the same file', () => {
    assert.equal(normalizeTarget('C:\\Docs\\A.PDF', 'win32'), normalizeTarget('c:\\docs\\a.pdf', 'win32'));
  });

  it('returns an empty string for input it cannot make sense of', () => {
    assert.equal(normalizeTarget('', 'linux'), '');
    assert.equal(normalizeTarget(null, 'linux'), '');
  });
});
