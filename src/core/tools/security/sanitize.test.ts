import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { sanitizeTool } from './sanitize.ts';
import { openDocument } from '../../pdf/document.ts';

describe('security.sanitize', () => {
  it('runs successfully on a clean document', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'clean.pdf');
    const result = await executeTool(sanitizeTool, {
      files: [input],
      params: { strip: ['javascript', 'openActions', 'embeddedFiles', 'externalLinks'] },
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, 'clean_sanitized.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    assert.equal(doc.countPages(), 1);
    doc.destroy();
  });
});
