const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const ciWorkflow = readFileSync(
  join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);

describe('dependency security policy', () => {
  it('uses the maintained SheetJS package instead of vulnerable npm xlsx 0.18', () => {
    assert.equal(packageJson.dependencies.exceljs, undefined);
    assert.equal(
      packageJson.dependencies.xlsx,
      'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
    );
  });

  it('blocks vulnerabilities in shipped dependencies without breaking build-only tools', () => {
    assert.match(ciWorkflow, /npm audit --omit=dev --audit-level=high/);
  });

  /**
   * An override pins a transitive dependency to a version known good *at the
   * time it was written*. That makes it a floor that stops rising: `fast-uri`
   * was pinned to 3.1.5 to escape one advisory, and four later advisories then
   * named 3.0.0–3.1.5 as the affected range — the pin was holding the tree
   * inside it. So each pin needs a lower bound that is checked, not assumed.
   */
  it('keeps the fast-uri override above the range four SSRF advisories name', () => {
    const [major, minor, patch] = packageJson.overrides['fast-uri'].split('.').map(Number);
    assert.ok(
      major > 3 || (major === 3 && (minor > 1 || (minor === 1 && patch >= 7))),
      `fast-uri override ${packageJson.overrides['fast-uri']} is inside GHSA-5jgf-p345-68v8 (<= 3.1.5)`,
    );
  });

  it('builds the worker bundle before running worker integration coverage', () => {
    assert.match(packageJson.scripts['test:coverage'], /^npm run build:node && c8 /);
  });
});
