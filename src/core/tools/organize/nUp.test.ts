import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { nUpTool } from './nUp.ts';
import { openDocument } from '../../pdf/document.ts';

describe('organize.n-up', () => {
  it('lays out pages N-up', async () => {
    const input = asInput(await samplePdf({ pages: 4 }), 'test.pdf');
    const result = await executeTool(nUpTool, {
      files: [input],
      params: { n: '4', gap: 12 },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'test_4up.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    assert.equal(doc.countPages(), 1);
    doc.destroy();
  });

  it('supports 2-up', async () => {
    const input = asInput(await samplePdf({ pages: 4 }), 'test.pdf');
    const result = await executeTool(nUpTool, {
      files: [input],
      params: { n: '2', gap: 12 },
    });

    assert.equal(result.files.length, 1);
    const doc = openDocument(result.files[0]!.bytes);
    assert.equal(doc.countPages(), 2);
    doc.destroy();
  });
});
