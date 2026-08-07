import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { compareTool } from './compare.ts';

describe('edit.compare', () => {
  it('reports when two documents are identical', async () => {
    const pdfBytes = await samplePdf({ pages: 1, label: () => 'Hello World' });
    const fileA = asInput(pdfBytes, 'a.pdf');
    const fileB = asInput(pdfBytes, 'b.pdf');

    const result = await executeTool(compareTool, {
      files: [fileA, fileB],
      params: {},
    });

    const rowsA = result.data as Array<{ label: { en: string; zh: string }; value: string }>;
    assert.equal(rowsA.at(-1)?.value, '=');
  });

  it('reports differences between documents', async () => {
    const fileA = asInput(await samplePdf({ pages: 1, label: () => 'Hello World' }), 'a.pdf');
    const fileB = asInput(await samplePdf({ pages: 1, label: () => 'Hello Changed World' }), 'b.pdf');

    const result = await executeTool(compareTool, {
      files: [fileA, fileB],
      params: {},
    });

    const rowsB = result.data as Array<{ label: { en: string; zh: string }; value: string }>;
    // Should not report '='
    assert.notEqual(rowsB.at(-1)?.value, '=');
    // Should have page diffs
    assert.ok(rowsB.some((row) => row.value === '+1 / −0'));
  });

  it('rejects if not enough documents are provided', async () => {
    const fileA = asInput(await samplePdf({ pages: 1 }), 'a.pdf');
    await assert.rejects(
      executeTool(compareTool, { files: [fileA], params: {} }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_INPUT'
    );
  });
});
