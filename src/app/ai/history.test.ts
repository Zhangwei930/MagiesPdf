import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { HISTORY_CHAR_BUDGET, trimHistory } from './history.ts';

const message = (role: 'user' | 'assistant', content: string) => ({ role, content });

describe('trimHistory', () => {
  it('keeps a short conversation whole', () => {
    const history = [message('user', 'a'), message('assistant', 'b')];
    assert.deepEqual(trimHistory(history), history);
  });

  it('drops the oldest turns once the budget is exceeded', () => {
    const big = 'x'.repeat(HISTORY_CHAR_BUDGET / 2);
    const history = [
      message('user', `first ${big}`),
      message('assistant', `second ${big}`),
      message('user', `third ${big}`),
    ];

    const trimmed = trimHistory(history);
    // The most recent turns are the ones that matter; the model rejects the
    // whole request rather than truncating when the window is exceeded.
    assert.ok(trimmed.length < history.length);
    assert.equal(trimmed.at(-1)?.content.startsWith('third'), true);
    assert.equal(trimmed.some((entry) => entry.content.startsWith('first')), false);
  });

  it('never returns an empty history while one message could fit', () => {
    const enormous = message('user', 'y'.repeat(HISTORY_CHAR_BUDGET * 3));
    const trimmed = trimHistory([enormous]);
    assert.equal(trimmed.length, 1);
    // Kept, but shortened: sending three budgets of text fails outright.
    assert.ok((trimmed[0]?.content.length ?? 0) <= HISTORY_CHAR_BUDGET);
  });

  it('handles an empty conversation', () => {
    assert.deepEqual(trimHistory([]), []);
  });
});
