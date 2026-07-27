import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from './errors.ts';
import { ToolRegistry } from './registry.ts';
import type { CategoryId, ToolDescriptor } from './types.ts';

function tool(
  id: string,
  category: CategoryId,
  zh: string,
  en: string,
  keywords: string[] = [],
): ToolDescriptor {
  return {
    id,
    category,
    name: { zh, en },
    description: { zh: `${zh}的说明`, en: `About ${en}` },
    icon: 'File',
    keywords,
    input: { accept: ['.pdf'], min: 1, max: null },
    output: 'single',
    params: [],
    runtime: 'worker',
    run: async () => ({ files: [] }),
  };
}

function seeded(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(tool('organize.merge', 'organize', '合并 PDF', 'Merge PDF', ['combine', '合并', 'join']));
  r.register(tool('organize.split', 'organize', '拆分 PDF', 'Split PDF', ['divide', '分割']));
  r.register(tool('security.add-password', 'security', '添加密码', 'Add Password', ['encrypt', '加密']));
  r.register(tool('edit.compress', 'edit', '压缩 PDF', 'Compress PDF', ['shrink', '瘦身']));
  return r;
}

describe('ToolRegistry.register', () => {
  it('rejects a duplicate id', () => {
    const r = seeded();
    assert.throws(() => r.register(tool('organize.merge', 'organize', 'x', 'x')), /already registered/);
  });

  it('rejects an id that is not dotted category.name form', () => {
    const r = new ToolRegistry();
    assert.throws(() => r.register(tool('merge', 'organize', 'x', 'x')), /dotted/);
  });

  it('rejects an id whose prefix disagrees with its category', () => {
    const r = new ToolRegistry();
    assert.throws(() => r.register(tool('edit.merge', 'organize', 'x', 'x')), /category/);
  });
});

describe('ToolRegistry.get', () => {
  it('returns a registered tool', () => {
    assert.equal(seeded().get('organize.merge').name.en, 'Merge PDF');
  });

  it('throws a typed error for an unknown id', () => {
    assert.throws(() => seeded().get('nope.nope'), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'INVALID_INPUT');
      return true;
    });
  });

  it('tryGet returns undefined instead of throwing', () => {
    assert.equal(seeded().tryGet('nope.nope'), undefined);
  });
});

describe('ToolRegistry.byCategory', () => {
  it('returns only that category, in registration order', () => {
    assert.deepEqual(
      seeded().byCategory('organize').map((t) => t.id),
      ['organize.merge', 'organize.split'],
    );
  });
});

describe('ToolRegistry.search', () => {
  it('finds a tool by its English name', () => {
    assert.equal(seeded().search('merge', 'en')[0]?.id, 'organize.merge');
  });

  it('finds a tool by its Chinese name regardless of active locale', () => {
    assert.equal(seeded().search('合并', 'en')[0]?.id, 'organize.merge');
    assert.equal(seeded().search('压缩', 'zh')[0]?.id, 'edit.compress');
  });

  it('finds a tool by keyword', () => {
    assert.equal(seeded().search('encrypt', 'en')[0]?.id, 'security.add-password');
  });

  it('finds a tool by id fragment', () => {
    assert.equal(seeded().search('add-password', 'en')[0]?.id, 'security.add-password');
  });

  it('ranks a name prefix above a description-only match', () => {
    const r = new ToolRegistry();
    r.register(tool('edit.compress', 'edit', '压缩', 'Compress'));
    r.register(tool('organize.split', 'organize', '拆分', 'Split', ['compress-adjacent']));
    assert.equal(r.search('compress', 'en')[0]?.id, 'edit.compress');
  });

  it('is case insensitive', () => {
    assert.equal(seeded().search('MERGE', 'en')[0]?.id, 'organize.merge');
  });

  it('returns every tool for a blank query', () => {
    assert.equal(seeded().search('   ', 'en').length, 4);
  });

  it('returns nothing when there is no match', () => {
    assert.deepEqual(seeded().search('zzzz', 'en'), []);
  });

  it('honours the result limit', () => {
    assert.equal(seeded().search('', 'en', 2).length, 2);
  });
});
