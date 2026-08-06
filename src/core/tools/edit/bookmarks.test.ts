import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { bookmarksTool } from './bookmarks.ts';

describe('edit.bookmarks', () => {
  it('sets and lists bookmarks', async () => {
    const pdfBytes = await samplePdf({ pages: 3 });
    const host = asInput(pdfBytes, 'host.pdf');
    
    // Set bookmarks
    const entries = 'Chapter 1 | 1\n  Section 1.1 | 2\nChapter 2 | 3';
    const setResult = await executeTool(bookmarksTool, {
      files: [host],
      params: { action: 'set', entries },
    });
    
    assert.equal(setResult.files.length, 1);
    
    // List bookmarks
    const bookmarked = asInput(setResult.files[0]!.bytes, 'bookmarked.pdf');
    const listResult = await executeTool(bookmarksTool, {
      files: [bookmarked],
      params: { action: 'list' },
    });
    
    const rows = listResult.data as Array<{ label: { en: string; zh: string }; value: string }>;
    assert.equal(rows.length, 3);
    assert.ok(rows[0]!.label.en.includes('Chapter 1'));
    assert.ok(rows[1]!.label.en.includes('Section 1.1'));
  });

  it('clears bookmarks', async () => {
    const pdfBytes = await samplePdf({ pages: 3 });
    const host = asInput(pdfBytes, 'host.pdf');
    const entries = 'Chapter 1 | 1';
    const setResult = await executeTool(bookmarksTool, {
      files: [host],
      params: { action: 'set', entries },
    });
    
    const bookmarked = asInput(setResult.files[0]!.bytes, 'bookmarked.pdf');
    const clearResult = await executeTool(bookmarksTool, {
      files: [bookmarked],
      params: { action: 'clear' },
    });
    
    assert.equal(clearResult.files.length, 1);
    assert.equal(clearResult.files[0]!.name, 'bookmarked_nobookmarks.pdf');
  });

  it('throws on invalid bookmarks format', async () => {
    const pdfBytes = await samplePdf({ pages: 1 });
    const host = asInput(pdfBytes, 'host.pdf');
    await assert.rejects(
      executeTool(bookmarksTool, { files: [host], params: { action: 'set', entries: 'Missing Page' } }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM'
    );
  });
});
