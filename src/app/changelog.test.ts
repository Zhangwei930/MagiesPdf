import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countChangelogItems, parseChangelog } from './changelog.ts';

describe('parseChangelog', () => {
  it('parses version headers, sections and bullets', () => {
    const entries = parseChangelog(`
# Changelog

## 1.0.0 — 2026-07-27

First public release.

### Highlights

- **57 local PDF tools**
- Drawer sidebar

### Platforms

- macOS
`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.version, '1.0.0');
    assert.equal(entries[0]!.date, '2026-07-27');
    assert.ok(countChangelogItems(entries[0]!) >= 3);
    assert.ok(entries[0]!.sections.some((s) => s.title === 'Highlights'));
  });

  it('supports multiple versions newest first', () => {
    const entries = parseChangelog(`
## 1.1.0 — 2026-08-01

### Fixes

- bug

## 1.0.0 — 2026-07-27

### Features

- ship
`);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.version, '1.1.0');
    assert.equal(entries[1]!.version, '1.0.0');
  });
});
