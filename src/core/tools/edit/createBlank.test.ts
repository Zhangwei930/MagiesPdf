import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { createBlankTool } from './createBlank.ts';

describe('edit.create-blank', () => {
  it('creates the requested number of pages', async () => {
    const result = await executeTool(createBlankTool, {
      files: [],
      params: { pages: 3, pageSize: 'a4', labelPages: false },
    });

    assert.equal(result.files[0]!.name, 'blank.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(doc.countPages(), 3);
    } finally {
      doc.destroy();
    }
  });

  it('honours a custom file name and letter size', async () => {
    const result = await executeTool(createBlankTool, {
      files: [],
      params: { pages: 1, pageSize: 'letter', fileName: 'notes' },
    });
    assert.equal(result.files[0]!.name, 'notes.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    try {
      const [, , w, h] = doc.loadPage(0).getBounds();
      assert.equal(Math.round(w), 612);
      assert.equal(Math.round(h), 792);
    } finally {
      doc.destroy();
    }
  });
});
