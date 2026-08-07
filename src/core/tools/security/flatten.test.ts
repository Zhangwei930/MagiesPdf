import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { flattenTool } from './flatten.ts';
import { openDocument } from '../../pdf/document.ts';

describe('security.flatten', () => {
  it('flattens forms in a document', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'forms.pdf');
    const result = await executeTool(flattenTool, {
      files: [input],
      params: { annotations: false },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'forms_flat.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    assert.equal(doc.countPages(), 1);
    doc.destroy();
  });

  it('flattens annotations as well when requested', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'annotated.pdf');
    const result = await executeTool(flattenTool, {
      files: [input],
      params: { annotations: true },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'annotated_flat.pdf');
  });
});
