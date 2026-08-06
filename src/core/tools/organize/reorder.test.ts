import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { reorderTool } from './reorder.ts';

describe('organize.reorder', () => {
  it('reverses the document', async () => {
    const input = asInput(await samplePdf({ pages: 3, label: (n) => `Page ${n}` }), 'test.pdf');
    const result = await executeTool(reorderTool, {
      files: [input],
      params: { preset: 'reverse' },
    });

    assert.equal(result.files.length, 1);
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['Page 3', 'Page 2', 'Page 1']);
  });

  it('supports custom orders', async () => {
    const input = asInput(await samplePdf({ pages: 3, label: (n) => `Page ${n}` }), 'test.pdf');
    const result = await executeTool(reorderTool, {
      files: [input],
      params: { preset: 'custom', order: '2, 1, 3' },
    });

    assert.equal(result.files.length, 1);
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['Page 2', 'Page 1', 'Page 3']);
  });
});
