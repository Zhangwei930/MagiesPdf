import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { removeBlankTool } from './removeBlank.ts';

describe('organize.remove-blank-pages', () => {
  it('removes blank pages from the document', async () => {
    const input = asInput(await samplePdf({ pages: 2, label: (n) => (n === 1 ? '' : 'Content') }), 'test.pdf');
    const result = await executeTool(removeBlankTool, {
      files: [input],
      params: { sensitivity: 'normal' },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'test_noblank.pdf');
  });

  it('reports when no blank pages are found', async () => {
    const input = asInput(await samplePdf({ pages: 1, label: () => 'Content' }), 'test.pdf');
    await assert.rejects(
      executeTool(removeBlankTool, {
        files: [input],
        params: { sensitivity: 'strict' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'EMPTY_RESULT'
    );
  });
});
