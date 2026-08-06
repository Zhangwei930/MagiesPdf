import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { addWatermarkTool } from './watermark.ts';
import { openDocument } from '../../pdf/document.ts';

describe('security.add-watermark', () => {
  it('adds a watermark to the specified pages', async () => {
    const input = asInput(await samplePdf({ pages: 3 }), 'test.pdf');
    const result = await executeTool(addWatermarkTool, {
      files: [input],
      params: { text: 'CONFIDENTIAL', size: 48, opacity: 0.5, rotation: 45, color: '#ff0000', tile: false, pages: '1,3' },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'test_watermarked.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    assert.equal(doc.countPages(), 3);
    doc.destroy();
  });

  it('supports CJK characters', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'test.pdf');
    const result = await executeTool(addWatermarkTool, {
      files: [input],
      params: { text: '机密文档', size: 48, opacity: 0.5, rotation: 0, color: '#000000', tile: false, pages: '1' },
    });
    assert.ok(result.files[0]!.bytes.length > 0);
  });

  it('supports tiling', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'test.pdf');
    const result = await executeTool(addWatermarkTool, {
      files: [input],
      params: { text: 'TILE', size: 24, opacity: 0.1, rotation: -45, color: '#111111', tile: true, pages: '1' },
    });
    assert.ok(result.files[0]!.bytes.length > 0);
  });
});
