import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOpenGuard } from './openGuard.ts';
import { setPathCaseSensitivity } from './documents.ts';

/**
 * Deduplicating against the open tabs is not enough, because a tab only exists
 * once opening has finished. Two requests for the same file that arrive while
 * neither has finished — a drop landing as `open-file` fires, a double-click
 * on two copies of a shortcut — both see nothing open and both ask the engine
 * for a session. One tab appears; the other session is left with nothing
 * referencing it and nothing able to close it, holding a copy of the document
 * in a temp directory. That is the leak issue #29 fixed for every path except
 * this one.
 */
describe('opening the same file twice at once', () => {
  it('lets a first request through', () => {
    const guard = createOpenGuard();
    assert.deepEqual(guard.claim(['/docs/a.docx']), ['/docs/a.docx']);
  });

  it('refuses a second request for a file still being opened', () => {
    const guard = createOpenGuard();
    guard.claim(['/docs/a.docx']);
    assert.deepEqual(guard.claim(['/docs/a.docx']), []);
  });

  it('lets the rest of a batch through', () => {
    const guard = createOpenGuard();
    guard.claim(['/docs/a.docx']);
    assert.deepEqual(
      guard.claim(['/docs/a.docx', '/docs/b.xlsx']),
      ['/docs/b.xlsx'],
    );
  });

  it('allows the file again once the first attempt has finished', () => {
    const guard = createOpenGuard();
    const claimed = guard.claim(['/docs/a.docx']);
    guard.release(claimed);
    assert.deepEqual(guard.claim(['/docs/a.docx']), ['/docs/a.docx']);
  });

  /**
   * A failed open has to release its claim, or the file can never be opened
   * again without restarting the app.
   */
  it('releases a claim whether the open succeeded or threw', () => {
    const guard = createOpenGuard();
    const claimed = guard.claim(['/docs/a.docx']);
    guard.release(claimed);
    assert.deepEqual(guard.pending(), []);
  });

  it('releases only what it was given, not the whole queue', () => {
    const guard = createOpenGuard();
    guard.claim(['/docs/a.docx']);
    const second = guard.claim(['/docs/b.xlsx']);
    guard.release(second);
    assert.deepEqual(guard.claim(['/docs/a.docx']), [], 'a is still being opened');
    assert.deepEqual(guard.claim(['/docs/b.xlsx']), ['/docs/b.xlsx']);
  });

  it('counts two spellings of one path as one file', () => {
    setPathCaseSensitivity('darwin');
    const guard = createOpenGuard();
    guard.claim(['C:\\Docs\\Report.docx']);
    assert.deepEqual(guard.claim(['c:/docs/report.docx']), []);
  });

  it('does not deduplicate within one batch beyond what it must', () => {
    const guard = createOpenGuard();
    assert.deepEqual(
      guard.claim(['/docs/a.docx', '/docs/a.docx']),
      ['/docs/a.docx'],
      'one session for one file, even when named twice in the same call',
    );
  });

  it('ignores an empty path rather than claiming it', () => {
    const guard = createOpenGuard();
    assert.deepEqual(guard.claim(['']), []);
  });
});
