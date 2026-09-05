import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const viewer = readFileSync(new URL('./Viewer.tsx', import.meta.url), 'utf8');
const runSearch = /const runSearch = useCallback\([\s\S]{0,2200}/.exec(viewer)?.[0] ?? '';

/**
 * Searching a long document walks every page, so a search outlives the
 * keystroke that started it. Three ways that went wrong.
 */
describe('a search that is still running when what was asked changes', () => {
  it('is abandoned when the box is typed into', () => {
    const onChange = /onChange=\{\(event\) => \{\s*setQuery\(event\.target\.value\);[\s\S]{0,120}/
      .exec(viewer)?.[0];

    assert.ok(onChange, 'the find input moved; this test needs updating');
    // Clearing the matches was not enough: the old search still owned the run
    // number, finished, and filled its own results back in. The next Enter
    // then saw a non-empty list and stepped through the old word's hits.
    assert.match(onChange, /invalidateSearch\(\)/);
  });

  it('is abandoned when the document underneath it is replaced', () => {
    const effect = /textCache\.current = new Map\(\);[\s\S]{0,300}/.exec(viewer)?.[0] ?? '';
    assert.match(effect, /searchRun\.current \+= 1/);
  });

  it('is abandoned when the find bar is closed', () => {
    const close = /const closeFind = useCallback\([\s\S]{0,220}/.exec(viewer)?.[0] ?? '';
    assert.match(close, /invalidateSearch\(\)/);
  });

  /**
   * "Searching…" used to be cleared only by whichever run was still current,
   * so an abandoned one cleared nothing and the bar said "searching…" for the
   * rest of the session.
   */
  it('stops saying "searching" once nothing is searching', () => {
    assert.match(runSearch, /searchesInFlight\.current -= 1/);
    assert.match(runSearch, /searchesInFlight\.current === 0/);
    assert.doesNotMatch(runSearch, /if \(isCurrent\(\)\) setSearching\(false\)/);
  });
});
