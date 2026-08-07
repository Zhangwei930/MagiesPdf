import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { repairTool } from './repair.ts';

describe('edit.repair', () => {
  it('repairs a document', async () => {
    const pdfBytes = await samplePdf({ pages: 1 });
    const input = asInput(pdfBytes, 'test.pdf');
    
    // While the doc is not corrupt, running repair should just rebuild it successfully
    const result = await executeTool(repairTool, {
      files: [input],
      params: {},
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'test_repaired.pdf');
  });
});
