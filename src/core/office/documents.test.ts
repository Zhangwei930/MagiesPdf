import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';
import { zipRead } from '../ooxml/zip.ts';
import {
  createBlankOfficeDocument,
  documentKindFromName,
  type OfficeDocumentKind,
} from './documents.ts';

describe('documentKindFromName', () => {
  it('recognises editable Office and PDF formats case-insensitively', () => {
    const cases: Array<[string, OfficeDocumentKind]> = [
      ['letter.DOCX', 'word'],
      ['legacy.doc', 'word'],
      ['notes.odt', 'word'],
      ['budget.XLSX', 'sheet'],
      ['legacy.xls', 'sheet'],
      ['data.ods', 'sheet'],
      ['deck.PPTX', 'slide'],
      ['legacy.ppt', 'slide'],
      ['deck.odp', 'slide'],
      ['scan.PDF', 'pdf'],
    ];

    for (const [name, kind] of cases) assert.equal(documentKindFromName(name), kind, name);
  });

  it('rejects formats the document workspace cannot edit', () => {
    assert.equal(documentKindFromName('notes.txt'), null);
    assert.equal(documentKindFromName('archive.zip'), null);
    assert.equal(documentKindFromName('no-extension'), null);
  });
});

describe('createBlankOfficeDocument', () => {
  it('builds a valid empty DOCX package', () => {
    const file = createBlankOfficeDocument('word');
    const entries = zipRead(file.bytes);

    assert.equal(file.name, 'Untitled.docx');
    assert.equal(file.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.ok(entries.has('word/document.xml'));
  });

  it('builds an XLSX workbook with one visible sheet', () => {
    const file = createBlankOfficeDocument('sheet');
    const workbook = XLSX.read(file.bytes, { type: 'array' });

    assert.equal(file.name, 'Untitled.xlsx');
    assert.deepEqual(workbook.SheetNames, ['Sheet1']);
  });

  it('builds a PPTX package with one blank slide', () => {
    const file = createBlankOfficeDocument('slide');
    const entries = zipRead(file.bytes);

    assert.equal(file.name, 'Untitled.pptx');
    assert.ok(entries.has('ppt/slides/slide1.xml'));
  });

  it('does not pretend a PDF is an Office document template', () => {
    assert.throws(() => createBlankOfficeDocument('pdf'), /Office document kind/i);
  });
});
