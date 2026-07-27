import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { grayscaleTool } from './grayscale.ts';

describe('edit.grayscale', () => {
  it('produces a valid PDF with the same page count', async () => {
    const result = await executeTool(grayscaleTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (n) => `C${n}` }), 'c.pdf')],
      params: { dpi: 72 },
    });

    assert.equal(result.files[0]!.name, 'c_gray.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(doc.countPages(), 2);
    } finally {
      doc.destroy();
    }
  });

  it('respects page selection', async () => {
    const result = await executeTool(grayscaleTool, {
      files: [asInput(await samplePdf({ pages: 3 }), 'c.pdf')],
      params: { dpi: 72, pages: '1,3' },
    });
    const doc = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(doc.countPages(), 2);
    } finally {
      doc.destroy();
    }
  });
});
