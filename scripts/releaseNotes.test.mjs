import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sectionFor, versionFromRef } from './releaseNotes.mjs';

const CHANGELOG = `# Changelog

## 1.0.4 — 2026-07-29

### Reading

- Continuous scrolling.

## 1.0.3 — 2026-07-28

### Something else

- Older entry.

## 1.0.2 — 2026-07-27

- Oldest.
`;

describe('sectionFor', () => {
  it('returns just the requested version, without the ones below it', () => {
    const notes = sectionFor(CHANGELOG, '1.0.4');
    assert.match(notes, /Continuous scrolling/);
    assert.doesNotMatch(notes, /Older entry/);
    assert.doesNotMatch(notes, /Oldest/);
  });

  it('keeps the section headings and bullets', () => {
    const notes = sectionFor(CHANGELOG, '1.0.4');
    assert.match(notes, /### Reading/);
  });

  it('drops the version heading itself, which the release title already says', () => {
    assert.doesNotMatch(sectionFor(CHANGELOG, '1.0.4'), /^## 1\.0\.4/m);
  });

  it('reads a version in the middle of the file', () => {
    const notes = sectionFor(CHANGELOG, '1.0.3');
    assert.match(notes, /Older entry/);
    assert.doesNotMatch(notes, /Continuous scrolling/);
    assert.doesNotMatch(notes, /Oldest/);
  });

  it('reads the last version, which has no following heading to stop at', () => {
    assert.match(sectionFor(CHANGELOG, '1.0.2'), /Oldest/);
  });

  it('accepts a leading v, so a tag name can be passed straight in', () => {
    assert.match(sectionFor(CHANGELOG, 'v1.0.4'), /Continuous scrolling/);
  });

  it('returns empty for a version that is not in the changelog', () => {
    assert.equal(sectionFor(CHANGELOG, '9.9.9'), '');
  });

  it('does not match a version that merely starts the same', () => {
    // 1.0.4 must not be found when asking for 1.0, nor 1.0.40 for 1.0.4.
    assert.equal(sectionFor(CHANGELOG, '1.0'), '');
    assert.equal(sectionFor('# Changelog\n\n## 1.0.40 — x\n\n- a\n', '1.0.4'), '');
  });

  it('survives junk input instead of throwing during a release', () => {
    assert.equal(sectionFor('', '1.0.4'), '');
    assert.equal(sectionFor(null, '1.0.4'), '');
    assert.equal(sectionFor(CHANGELOG, ''), '');
  });
});

describe('versionFromRef', () => {
  it('reads the version out of a tag ref', () => {
    assert.equal(versionFromRef('refs/tags/v1.0.4'), '1.0.4');
  });

  it('reads a bare tag name too', () => {
    assert.equal(versionFromRef('v1.0.4'), '1.0.4');
  });

  it('keeps a pre-release suffix', () => {
    assert.equal(versionFromRef('refs/tags/v1.0.4-rc.1'), '1.0.4-rc.1');
  });

  it('returns empty for anything that is not a version tag', () => {
    assert.equal(versionFromRef('refs/heads/main'), '');
    assert.equal(versionFromRef('v-test'), '');
    assert.equal(versionFromRef(''), '');
    assert.equal(versionFromRef(null), '');
  });
});
