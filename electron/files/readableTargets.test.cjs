const assert = require('node:assert/strict');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');
const readableTargets = require('./readableTargets.cjs');

const abs = (...parts) => path.resolve('/tmp', ...parts);

describe('what the renderer is allowed to read', () => {
  beforeEach(() => readableTargets.forgetAll());

  it('refuses a path nothing granted, which is the whole point', () => {
    assert.equal(readableTargets.isReadable('/etc/passwd'), false);
    assert.equal(readableTargets.isReadable(abs('report.pdf')), false);
  });

  it('allows a path the main process granted', () => {
    readableTargets.grant(abs('report.pdf'));
    assert.equal(readableTargets.isReadable(abs('report.pdf')), true);
  });

  it('grants a whole selection at once', () => {
    readableTargets.grantAll([abs('a.pdf'), abs('b.pdf')]);
    assert.equal(readableTargets.isReadable(abs('a.pdf')), true);
    assert.equal(readableTargets.isReadable(abs('b.pdf')), true);
    assert.equal(readableTargets.isReadable(abs('c.pdf')), false);
  });

  /**
   * Knowing a path is not a capability. A compromised renderer can name any
   * file on the machine, and naming it must not be enough — that is exactly
   * the escalation issue #31 describes, where reading also earned the right to
   * overwrite.
   */
  it('is not fooled by spellings of a path that was never granted', () => {
    readableTargets.grant(abs('docs', 'report.pdf'));

    for (const candidate of [
      abs('docs', '..', 'docs', 'other.pdf'),
      abs('docs', 'report.pdf.bak'),
      '/etc/passwd',
      abs('docs'),
    ]) {
      assert.equal(readableTargets.isReadable(candidate), false, candidate);
    }
  });

  it('treats a relative path as no path at all', () => {
    readableTargets.grant(abs('report.pdf'));
    assert.equal(readableTargets.isReadable(''), false);
    assert.equal(readableTargets.isReadable('report.pdf'), false);
    assert.equal(readableTargets.isReadable(undefined), false);
    assert.equal(readableTargets.isReadable(42), false);
  });

  it('resolves a granted path the same way the filesystem would', () => {
    readableTargets.grant(abs('docs', '..', 'docs', 'report.pdf'));
    assert.equal(readableTargets.isReadable(abs('docs', 'report.pdf')), true);
  });

  it('separates reading from overwriting, so one does not imply the other', () => {
    const writableTargets = require('./writableTargets.cjs');
    writableTargets.forgetAll();

    readableTargets.grant(abs('report.pdf'));
    assert.equal(readableTargets.isReadable(abs('report.pdf')), true);
    assert.equal(
      writableTargets.isWritable(abs('report.pdf')),
      false,
      'being allowed to read must not, by itself, allow overwriting',
    );
  });

  it('bounds itself, evicting the oldest rather than growing forever', () => {
    for (let index = 0; index <= readableTargets.LIMIT; index += 1) {
      readableTargets.grant(abs(`file-${index}.pdf`));
    }

    assert.equal(readableTargets.isReadable(abs('file-0.pdf')), false, 'oldest evicted');
    assert.equal(readableTargets.isReadable(abs(`file-${readableTargets.LIMIT}.pdf`)), true);
  });

  it('keeps a file in use out of the eviction path when it is granted again', () => {
    readableTargets.grant(abs('kept.pdf'));
    for (let index = 0; index < readableTargets.LIMIT - 1; index += 1) {
      readableTargets.grant(abs(`file-${index}.pdf`));
    }
    readableTargets.grant(abs('kept.pdf'));
    readableTargets.grant(abs('one-more.pdf'));

    assert.equal(readableTargets.isReadable(abs('kept.pdf')), true);
  });
});
