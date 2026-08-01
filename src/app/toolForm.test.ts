import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ParamSpec, ParamValues } from '@core/types.ts';
import { pageRangePreset, partitionToolParams } from './toolForm.ts';

const label = { zh: '设置', en: 'Setting' };

function textParam(key: string, extra: Partial<ParamSpec> = {}): ParamSpec {
  return { key, type: 'text', label, default: '', ...extra } as ParamSpec;
}

describe('partitionToolParams', () => {
  it('keeps at most two common settings visible and moves the rest behind more settings', () => {
    const params = [
      textParam('one'),
      textParam('two'),
      textParam('three'),
      textParam('advanced', { advanced: true }),
    ];

    const result = partitionToolParams(params, {});

    assert.deepEqual(result.primary.map((param) => param.key), ['one', 'two']);
    assert.deepEqual(result.more.map((param) => param.key), ['three', 'advanced']);
  });

  it('excludes conditionally hidden settings before choosing the two primary controls', () => {
    const params = [
      textParam('hidden', { visibleWhen: { key: 'mode', equals: ['custom'] } }),
      textParam('one'),
      textParam('two'),
      textParam('three'),
    ];
    const values: ParamValues = { mode: 'preset' };

    const result = partitionToolParams(params, values);

    assert.deepEqual(result.primary.map((param) => param.key), ['one', 'two']);
    assert.deepEqual(result.more.map((param) => param.key), ['three']);
  });
});

describe('pageRangePreset', () => {
  it('recognises the three one-click choices and treats expressions as custom', () => {
    assert.equal(pageRangePreset('all'), 'all');
    assert.equal(pageRangePreset('odd'), 'odd');
    assert.equal(pageRangePreset('even'), 'even');
    assert.equal(pageRangePreset('1-3, 8'), 'custom');
  });
});
