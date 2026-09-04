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
    assert.equal(normalizeTarget('/docs/A.pdf', { platform: 'linux' }), path.resolve('/docs/A.pdf'));
  });

  it('folds case on Windows, where two spellings are the same file', () => {
    assert.equal(normalizeTarget('C:\\Docs\\A.PDF', { platform: 'win32' }), normalizeTarget('c:\\docs\\a.pdf', { platform: 'win32' }));
  });

  it('returns an empty string for input it cannot make sense of', () => {
    assert.equal(normalizeTarget('', { platform: 'linux' }), '');
    assert.equal(normalizeTarget(null, 'linux'), '');
  });
});

/**
 * `darwin` was treated as case-insensitive without exception, and APFS volumes
 * can be case-sensitive. There the fold is a *widening*: a grant for
 * `/docs/A.pdf` also permitted writing `/docs/a.pdf`, which on that volume is
 * a different file the user never chose. Same class as issue #31 — knowing a
 * path must not be enough.
 *
 * The filesystem is the only thing that can answer, so the grant records what
 * `realpath` makes of the path and the check compares against that. Where the
 * volume folds case, both spellings resolve to the same canonical name and the
 * grant still works; where it does not, they stay apart.
 */
describe('a macOS volume that does distinguish case', () => {
  it('does not let a grant for one spelling cover another', () => {
    forgetAll();
    remember('/vol/case-sensitive/A.pdf', {
      platform: 'darwin',
      realpath: (candidate) => candidate,
    });

    assert.equal(
      isWritable('/vol/case-sensitive/a.pdf', {
        platform: 'darwin',
        realpath: (candidate) => candidate,
      }),
      false,
      'a different file on this volume',
    );
    assert.equal(
      isWritable('/vol/case-sensitive/A.pdf', {
        platform: 'darwin',
        realpath: (candidate) => candidate,
      }),
      true,
    );
  });

  it('still covers both spellings where the volume folds them', () => {
    forgetAll();
    // What a case-insensitive volume's realpath does: it answers with the name
    // the file was created under, whichever spelling was asked about.
    const folding = () => '/vol/insensitive/Report.pdf';
    remember('/vol/insensitive/report.pdf', {
      platform: 'darwin',
      realpath: folding,
    });

    assert.equal(
      isWritable('/vol/insensitive/REPORT.PDF', {
        platform: 'darwin',
        realpath: folding,
      }),
      true,
    );
  });
});
