import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const viewerSource = readFileSync(new URL('./Viewer.tsx', import.meta.url), 'utf8');

/**
 * Extracting text from a long document takes a while, and every keystroke
 * starts another search. Without a run token, typing `B` while the search for
 * `A` was still walking the pages let A finish last and overwrite B — the
 * results on screen then belonged to a word the user had already replaced.
 * A page that could not be read became an unhandled rejection, and the stale
 * results stayed up as if they had answered.
 */
describe('searching a document that is still being searched', () => {
  it('numbers each search so a slower one cannot overwrite a newer', () => {
    assert.match(viewerSource, /searchRun\.current \+= 1/);
    assert.match(viewerSource, /const isCurrent = \(\) => searchRun\.current === run/);
  });

  it('abandons a search the moment it stops being the current one', () => {
    assert.match(viewerSource, /if \(!isCurrent\(\)\) return/);
  });

  it('does not leave the previous results standing when a page cannot be read', () => {
    assert.match(viewerSource, /\[viewer\] search failed/);
    assert.match(viewerSource, /catch \(cause\) \{[\s\S]{0,320}setMatches\(\[\]\)/);
  });
});
