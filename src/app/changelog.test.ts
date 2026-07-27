import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { countChangelogItems, parseChangelog } from './changelog.ts';

const dir = dirname(fileURLToPath(import.meta.url));

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
    // Synthetic versions only — product release is still 1.0.1.
    const entries = parseChangelog(`
## 9.9.0 — 2099-01-02

### Fixes

- bug

## 9.8.0 — 2099-01-01

### Features

- ship
`);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.version, '9.9.0');
    assert.equal(entries[1]!.version, '9.8.0');
  });
});

describe('locale changelog sources', () => {
  it('zh markdown is Chinese', () => {
    const raw = readFileSync(join(dir, 'changelog/zh.md'), 'utf8');
    assert.match(raw, /更新日志|亮点|首次打开/);
    assert.match(raw, /1\.0\.1/);
  });

  it('en markdown is English', () => {
    const raw = readFileSync(join(dir, 'changelog/en.md'), 'utf8');
    assert.match(raw, /Changelog|Highlights|First-launch/i);
    assert.match(raw, /1\.0\.1/);
  });

  it('zh and en share the same version set', () => {
    const zh = parseChangelog(readFileSync(join(dir, 'changelog/zh.md'), 'utf8')).map(
      (e) => e.version,
    );
    const en = parseChangelog(readFileSync(join(dir, 'changelog/en.md'), 'utf8')).map(
      (e) => e.version,
    );
    assert.deepEqual(zh, en);
  });
});
