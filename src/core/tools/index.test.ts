import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CATEGORY_IDS } from '../types.ts';
import { ALL_TOOLS, registerAllTools, registry } from './index.ts';

registerAllTools();

describe('tool catalogue', () => {
  it('registers every tool exactly once', () => {
    assert.equal(registry.list().length, ALL_TOOLS.length);
  });

  it('is idempotent, since several entry points call it', () => {
    registerAllTools();
    registerAllTools();
    assert.equal(registry.list().length, ALL_TOOLS.length);
  });

  it('gives every tool a unique id', () => {
    const ids = ALL_TOOLS.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('uses only known categories', () => {
    for (const tool of ALL_TOOLS) {
      assert.ok(CATEGORY_IDS.includes(tool.category), `${tool.id} has category ${tool.category}`);
    }
  });

  it('gives every tool bilingual name and description', () => {
    for (const tool of ALL_TOOLS) {
      assert.ok(tool.name.zh.length > 0, `${tool.id} missing zh name`);
      assert.ok(tool.name.en.length > 0, `${tool.id} missing en name`);
      assert.ok(tool.description.zh.length > 0, `${tool.id} missing zh description`);
      assert.ok(tool.description.en.length > 0, `${tool.id} missing en description`);
    }
  });

  it('gives every param a bilingual label and a unique key', () => {
    for (const tool of ALL_TOOLS) {
      const keys = tool.params.map((p) => p.key);
      assert.equal(new Set(keys).size, keys.length, `${tool.id} has duplicate param keys`);

      for (const param of tool.params) {
        assert.ok(param.label.zh.length > 0, `${tool.id}.${param.key} missing zh label`);
        assert.ok(param.label.en.length > 0, `${tool.id}.${param.key} missing en label`);
      }
    }
  });

  it('points every visibleWhen at a param that exists', () => {
    for (const tool of ALL_TOOLS) {
      const keys = new Set(tool.params.map((p) => p.key));
      for (const param of tool.params) {
        if (!param.visibleWhen) continue;
        assert.ok(
          keys.has(param.visibleWhen.key),
          `${tool.id}.${param.key} depends on unknown param "${param.visibleWhen.key}"`,
        );
      }
    }
  });

  it('gives every select param a default that is one of its options', () => {
    for (const tool of ALL_TOOLS) {
      for (const param of tool.params) {
        if (param.type !== 'select') continue;
        assert.ok(
          param.options.some((o) => o.value === param.default),
          `${tool.id}.${param.key} default "${param.default}" is not an option`,
        );
      }
    }
  });

  it('declares accepted extensions (except pure generators)', () => {
    for (const tool of ALL_TOOLS) {
      // Tools that create documents from scratch take no input files.
      if (tool.input.min === 0 && tool.input.max === 0) {
        assert.equal(tool.input.accept.length, 0, `${tool.id} generator should accept nothing`);
        continue;
      }
      assert.ok(tool.input.accept.length > 0, `${tool.id} accepts nothing`);
      for (const extension of tool.input.accept) {
        assert.match(extension, /^\.[a-z0-9]+$/, `${tool.id} extension "${extension}" is malformed`);
      }
    }
  });

  it('declares a sane min/max file count', () => {
    for (const tool of ALL_TOOLS) {
      const { min, max } = tool.input;
      assert.ok(min >= 0, `${tool.id} min must be non-negative`);
      if (max !== null) assert.ok(max >= min, `${tool.id} max ${max} is below min ${min}`);
    }
  });

  it('finds each tool by its own Chinese name', () => {
    for (const tool of ALL_TOOLS) {
      const hits = registry.search(tool.name.zh, 'zh');
      assert.equal(hits[0]?.id, tool.id, `searching "${tool.name.zh}" did not surface ${tool.id}`);
    }
  });
});
