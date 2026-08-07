import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { editMetadataTool, removeMetadataTool } from './metadata.ts';
import { openDocument } from '../../pdf/document.ts';

describe('security.metadata', () => {
  describe('edit-metadata', () => {
    it('updates specified metadata fields', async () => {
      const input = asInput(await samplePdf({ pages: 1 }), 'test.pdf');
      const result = await executeTool(editMetadataTool, {
        files: [input],
        params: { mode: 'update', title: 'New Title', author: 'New Author' },
      });

      assert.equal(result.files.length, 1);
      assert.equal(result.files[0]!.name, 'test_meta.pdf');
      const doc = openDocument(result.files[0]!.bytes);
      assert.equal(doc.getMetaData('info:Title'), 'New Title');
      assert.equal(doc.getMetaData('info:Author'), 'New Author');
      doc.destroy();
    });

    it('replaces metadata fields, clearing empty ones', async () => {
      // First set some metadata
      const input1 = asInput(await samplePdf({ pages: 1 }), 'test1.pdf');
      const result1 = await executeTool(editMetadataTool, {
        files: [input1],
        params: { mode: 'update', title: 'Old Title', author: 'Old Author' },
      });

      // Then replace
      const input2 = asInput(result1.files[0]!.bytes, 'test2.pdf');
      const result2 = await executeTool(editMetadataTool, {
        files: [input2],
        params: { mode: 'replace', title: 'Replaced Title' }, // author is omitted, so it becomes empty
      });

      const doc = openDocument(result2.files[0]!.bytes);
      assert.equal(doc.getMetaData('info:Title'), 'Replaced Title');
      assert.ok(!doc.getMetaData('info:Author'));
      doc.destroy();
    });
  });

  describe('remove-metadata', () => {
    it('strips metadata from the document', async () => {
      const input = asInput(await samplePdf({ pages: 1 }), 'test.pdf');
      // Update first
      const result1 = await executeTool(editMetadataTool, {
        files: [input],
        params: { mode: 'update', title: 'Secret Title' },
      });

      const result2 = await executeTool(removeMetadataTool, {
        files: [asInput(result1.files[0]!.bytes, 'test_meta.pdf')],
        params: {},
      });

      const doc = openDocument(result2.files[0]!.bytes);
      assert.ok(!doc.getMetaData('info:Title'));
      doc.destroy();
    });
  });
});
