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

  it('builds the worker bundle before running worker integration coverage', () => {
    assert.match(packageJson.scripts['test:coverage'], /^npm run build:node && c8 /);
  });
});
