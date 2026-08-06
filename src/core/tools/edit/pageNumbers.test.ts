import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { addPageNumbersTool } from './pageNumbers.ts';
import { openDocument } from '../../pdf/document.ts';

describe('edit.add-page-numbers', () => {
  it('adds page numbers to the document', async () => {
    const pdfBytes = await samplePdf({ pages: 2 });
    const input = asInput(pdfBytes, 'test.pdf');
    const result = await executeTool(addPageNumbersTool, {
      files: [input],
      params: { format: 'ofTotal', position: 'bottom-center', startAt: 1, size: 12, color: '#000000', pages: 'all' },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'test_numbered.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    assert.equal(doc.countPages(), 2);
    doc.destroy();
  });

  it('supports custom templates', async () => {
    const pdfBytes = await samplePdf({ pages: 1 });
    const input = asInput(pdfBytes, 'test.pdf');
    const result = await executeTool(addPageNumbersTool, {
      files: [input],
      params: { format: 'custom', template: 'Page {n}!!!', position: 'top-right', startAt: 5, size: 12, color: '#000000', pages: 'all' },
    });

    assert.equal(result.files.length, 1);
  });
});
