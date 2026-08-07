import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { overlayPdfTool } from './overlayPdf.ts';
import { openDocument } from '../../pdf/document.ts';

describe('organize.overlayPdf', () => {
  it('overlays the second document onto the first', async () => {
    const main = asInput(await samplePdf({ pages: 3 }), 'main.pdf');
    const overlay = asInput(await samplePdf({ pages: 1 }), 'overlay.pdf');
    const result = await executeTool(overlayPdfTool, {
      files: [main, overlay],
      params: { sequence: 'repeatFirst', fit: 'stretch', pages: 'all' },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'main_overlaid.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    assert.equal(doc.countPages(), 3);
    doc.destroy();
  });

  it('rejects fewer than two files', async () => {
    const main = asInput(await samplePdf({ pages: 1 }), 'main.pdf');
    await assert.rejects(
      executeTool(overlayPdfTool, {
        files: [main],
        params: { sequence: 'repeatFirst', fit: 'stretch', pages: 'all' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_INPUT'
    );
  });
});
