import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from './errors.ts';
import { defaultParams, isParamVisible, validateParams } from './params.ts';
import type { ParamSpec } from './types.ts';

const t = (zh: string, en: string) => ({ zh, en });

const specs: ParamSpec[] = [
  { key: 'title', type: 'text', label: t('标题', 'Title'), default: '', required: true },
  { key: 'copies', type: 'number', label: t('份数', 'Copies'), default: 1, min: 1, max: 10, integer: true },
  { key: 'flatten', type: 'boolean', label: t('扁平化', 'Flatten'), default: false },
  {
    key: 'mode',
    type: 'select',
    label: t('模式', 'Mode'),
    default: 'fast',
    options: [
      { value: 'fast', label: t('快速', 'Fast') },
      { value: 'strong', label: t('强力', 'Strong') },
    ],
  },
  {
    key: 'quality',
    type: 'number',
    label: t('质量', 'Quality'),
    default: 80,
    min: 1,
    max: 100,
    visibleWhen: { key: 'mode', equals: ['strong'] },
  },
  { key: 'tint', type: 'color', label: t('颜色', 'Tint'), default: '#ff0000' },
  {
    key: 'tags',
    type: 'multiselect',
    label: t('标签', 'Tags'),
    default: ['a'],
    options: [
      { value: 'a', label: t('甲', 'A') },
      { value: 'b', label: t('乙', 'B') },
    ],
    minSelected: 1,
  },
];

describe('defaultParams', () => {
  it('returns every declared default', () => {
    assert.deepEqual(defaultParams(specs), {
      title: '',
      copies: 1,
      flatten: false,
      mode: 'fast',
      quality: 80,
      tint: '#ff0000',
      tags: ['a'],
    });
  });

  it('copies array defaults so callers cannot mutate the descriptor', () => {
    const a = defaultParams(specs);
    (a.tags as string[]).push('b');
    assert.deepEqual(defaultParams(specs).tags, ['a']);
  });
});

describe('isParamVisible', () => {
  it('is true when the param declares no condition', () => {
    assert.equal(isParamVisible(specs[0]!, { mode: 'fast' }), true);
  });

  it('follows the controlling param value', () => {
    const quality = specs.find((s) => s.key === 'quality')!;
    assert.equal(isParamVisible(quality, { mode: 'fast' }), false);
    assert.equal(isParamVisible(quality, { mode: 'strong' }), true);
  });
});

describe('validateParams', () => {
  it('fills in defaults for omitted params', () => {
    const values = validateParams(specs, { title: 'hi' });
    assert.equal(values.copies, 1);
    assert.equal(values.mode, 'fast');
  });

  it('coerces numeric strings, which is what form inputs and the REST API send', () => {
    const values = validateParams(specs, { title: 'hi', copies: '3' });
    assert.equal(values.copies, 3);
  });

  it('coerces boolean strings', () => {
    assert.equal(validateParams(specs, { title: 'hi', flatten: 'true' }).flatten, true);
    assert.equal(validateParams(specs, { title: 'hi', flatten: 'false' }).flatten, false);
  });

  it('rejects a missing required text param', () => {
    assert.throws(() => validateParams(specs, {}), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'INVALID_PARAM');
      assert.equal((e.details as { key: string }).key, 'title');
      return true;
    });
  });

  it('rejects a number below its minimum', () => {
    assert.throws(() => validateParams(specs, { title: 'x', copies: 0 }), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal((e.details as { key: string }).key, 'copies');
      return true;
    });
  });

  it('rejects a non-integer where an integer is required', () => {
    assert.throws(() => validateParams(specs, { title: 'x', copies: 1.5 }), ToolError);
  });

  it('rejects a value outside the select options', () => {
    assert.throws(() => validateParams(specs, { title: 'x', mode: 'turbo' }), ToolError);
  });

  it('rejects a malformed colour', () => {
    assert.throws(() => validateParams(specs, { title: 'x', tint: 'red' }), ToolError);
  });

  it('normalises shorthand colours to six digits', () => {
    assert.equal(validateParams(specs, { title: 'x', tint: '#F0A' }).tint, '#ff00aa');
  });

  it('rejects an empty multiselect when a minimum is declared', () => {
    assert.throws(() => validateParams(specs, { title: 'x', tags: [] }), ToolError);
  });

  it('rejects unknown multiselect entries', () => {
    assert.throws(() => validateParams(specs, { title: 'x', tags: ['a', 'z'] }), ToolError);
  });

  it('skips validation for params hidden by their condition', () => {
    // `quality` is out of range but invisible while mode is "fast", so it must not fail.
    const values = validateParams(specs, { title: 'x', mode: 'fast', quality: 9999 });
    assert.equal(values.quality, 9999);
  });

  it('validates params once their condition makes them visible', () => {
    assert.throws(
      () => validateParams(specs, { title: 'x', mode: 'strong', quality: 9999 }),
      ToolError,
    );
  });

  it('drops keys that no param declares', () => {
    const values = validateParams(specs, { title: 'x', bogus: 'nope' });
    assert.equal('bogus' in values, false);
  });
});
