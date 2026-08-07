import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { scalePagesTool } from './scalePages.ts';
import { openDocument } from '../../pdf/document.ts';

describe('organize.scale-pages', () => {
  it('scales pages to a standard paper size', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'test.pdf');
    const result = await executeTool(scalePagesTool, {
      files: [input],
      params: { mode: 'paper', paper: 'a4', landscape: false },
    });

    assert.equal(result.files.length, 1);
    const doc = openDocument(result.files[0]!.bytes);
    const box = doc.loadPage(0).getBounds();
    // A4 width ~ 595.28
    assert.ok(Math.abs(box[2] - box[0] - 595.28) < 1);
    doc.destroy();
  });

  it('scales pages by percentage', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'test.pdf');
    const result = await executeTool(scalePagesTool, {
      files: [input],
      params: { mode: 'percent', percent: 50 },
    });
    assert.equal(result.files.length, 1);
  });
});
