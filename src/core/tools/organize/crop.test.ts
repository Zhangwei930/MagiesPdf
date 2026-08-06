import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { cropTool } from './crop.ts';
import { openDocument } from '../../pdf/document.ts';

describe('organize.crop', () => {
  it('crops using fixed margins', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'test.pdf');
    const result = await executeTool(cropTool, {
      files: [input],
      params: { mode: 'margins', top: 10, bottom: 10, left: 10, right: 10, hardCrop: false, pages: '1' },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'test_cropped.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    const box = doc.loadPage(0).getBounds();
    assert.ok(box[2] > box[0]);
    doc.destroy();
  });

  it('rejects margins that are too large', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'test.pdf');
    await assert.rejects(
      executeTool(cropTool, {
        files: [input],
        params: { mode: 'margins', top: 5000, bottom: 5000, left: 5000, right: 5000, hardCrop: false, pages: '1' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM'
    );
  });
});
