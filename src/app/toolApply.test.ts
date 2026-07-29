import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolMeta, ToolOutputFile } from '@core/types.ts';
import { canApplyToDocument, classifyOutput } from './toolApply.ts';

const tool = (input: Partial<ToolMeta['input']>): ToolMeta =>
  ({
    id: 'organize.rotate',
    input: { accept: ['.pdf'], min: 1, max: 1, ...input },
  }) as ToolMeta;

const output = (name: string, size = 4): ToolOutputFile => ({
  name,
  mime: 'application/pdf',
  bytes: new Uint8Array(size),
});

describe('canApplyToDocument', () => {
  it('accepts a tool that takes exactly one PDF', () => {
    assert.equal(canApplyToDocument(tool({})), true);
  });

  it('rejects a tool that needs several files, which the open document cannot supply', () => {
    assert.equal(canApplyToDocument(tool({ min: 2, max: null })), false);
    assert.equal(canApplyToDocument(tool({ min: 1, max: null })), false);
    assert.equal(canApplyToDocument(tool({ min: 1, max: 4 })), false);
  });

  it('rejects a tool that does not read PDFs at all', () => {
    assert.equal(canApplyToDocument(tool({ accept: ['.docx'] })), false);
  });

  it('accepts a tool whose second file is optional', () => {
    // A stamp takes the document plus an image, but the image is picked
    // separately — the document is still the one required input.
    assert.equal(canApplyToDocument(tool({ min: 0, max: 1 })), true);
  });

  it('rejects a tool that takes no files, since there is nothing to apply it to', () => {
    assert.equal(canApplyToDocument(tool({ min: 0, max: 0 })), false);
  });
});

describe('classifyOutput', () => {
  it('treats a lone PDF as the document itself, so it can replace it', () => {
    const result = classifyOutput([output('report.pdf')]);
    assert.equal(result.kind, 'document');
  });

  it('matches the extension case-insensitively', () => {
    assert.equal(classifyOutput([output('REPORT.PDF')]).kind, 'document');
  });

  it('treats a lone non-PDF as a file to save, not a new document', () => {
    // Converting to Word cannot replace the PDF being viewed.
    assert.equal(classifyOutput([output('report.docx')]).kind, 'files');
  });

  it('treats several outputs as files to save', () => {
    // Splitting produces many PDFs; none of them is "the" document.
    assert.equal(classifyOutput([output('a.pdf'), output('b.pdf')]).kind, 'files');
  });

  it('treats no output as files, so a report tool does not blank the document', () => {
    assert.equal(classifyOutput([]).kind, 'files');
  });

  it('carries the bytes through when it is a document', () => {
    const only = output('report.pdf', 7);
    const result = classifyOutput([only]);
    assert.equal(result.kind, 'document');
    if (result.kind === 'document') assert.equal(result.bytes.length, 7);
  });
});
