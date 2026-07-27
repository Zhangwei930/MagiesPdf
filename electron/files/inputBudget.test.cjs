const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { InputBudget } = require('./inputBudget.cjs');

describe('input memory budget', () => {
  it('accepts files within per-file, total, and count limits', () => {
    const budget = new InputBudget({ maxFileBytes: 10, maxTotalBytes: 15, maxFiles: 2 });
    budget.add(6);
    budget.add(9);
    assert.equal(budget.totalBytes, 15);
    assert.equal(budget.fileCount, 2);
  });

  it('rejects one oversized file before it is read', () => {
    const budget = new InputBudget({ maxFileBytes: 10, maxTotalBytes: 20, maxFiles: 2 });
    assert.throws(() => budget.add(11), /file is too large/i);
  });

  it('rejects an excessive aggregate or file count', () => {
    const aggregate = new InputBudget({ maxFileBytes: 10, maxTotalBytes: 10, maxFiles: 2 });
    aggregate.add(6);
    assert.throws(() => aggregate.add(5), /total input/i);

    const count = new InputBudget({ maxFileBytes: 10, maxTotalBytes: 30, maxFiles: 1 });
    count.add(1);
    assert.throws(() => count.add(1), /too many files/i);
  });
});
