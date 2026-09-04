const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  officeSaveAsDialogOptions,
  officeSaveAsFilters,
  pdfExportName,
} = require('./formats.cjs');

/**
 * "输出为 PDF" is its own action, and what it proposes has to be a PDF. The
 * shell used to pass the document's own name through, so `report.docx` was
 * offered as `report.docx` and confirming it turned the export into an
 * ordinary Save As. See issue #24.
 */
describe('the name an export proposes', () => {
  it('swaps the document extension for .pdf', () => {
    assert.equal(pdfExportName('report.docx'), 'report.pdf');
    assert.equal(pdfExportName('年度报告.xlsx'), '年度报告.pdf');
    assert.equal(pdfExportName('deck.pptx'), 'deck.pdf');
  });

  it('adds one when the name has no extension', () => {
    assert.equal(pdfExportName('report'), 'report.pdf');
  });

  it('keeps a name that is already a PDF', () => {
    assert.equal(pdfExportName('report.pdf'), 'report.pdf');
  });

  it('falls back rather than producing a bare extension', () => {
    assert.equal(pdfExportName(''), 'document.pdf');
    assert.equal(pdfExportName('.docx'), '.docx.pdf');
  });
});

describe('the type dropdown for a save target', () => {
  it('offers only PDF once the name is one, so an export cannot become a Save As', () => {
    assert.deepEqual(officeSaveAsFilters('report.pdf'), [
      { name: 'PDF 文件 (*.pdf)', extensions: ['pdf'] },
    ]);
    assert.deepEqual(officeSaveAsDialogOptions('report.pdf').filters, [
      { name: 'PDF 文件 (*.pdf)', extensions: ['pdf'] },
    ]);
  });

  it('offers the document formats for a document name', () => {
    const forWord = officeSaveAsFilters('report.docx').map((filter) => filter.extensions[0]);
    assert.deepEqual(forWord, ['docx', 'pdf', 'odt', 'rtf']);

    const forSheet = officeSaveAsFilters('book.xlsx').map((filter) => filter.extensions[0]);
    assert.deepEqual(forSheet, ['xlsx', 'pdf', 'ods']);
  });

  it('proposes the name it was given', () => {
    assert.equal(officeSaveAsDialogOptions('report.pdf').defaultPath, 'report.pdf');
  });
});
