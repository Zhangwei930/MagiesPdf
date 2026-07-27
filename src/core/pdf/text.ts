import type * as mupdf from 'mupdf';

/**
 * Shared text extraction used by the export tools (txt/md/html/docx/xlsx/pptx).
 * Keeps block boundaries so paragraph structure survives the round trip.
 */

export function pageBlocks(doc: mupdf.PDFDocument, pageIndex: number): string[] {
  const structured = JSON.parse(
    doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asJSON(),
  ) as { blocks: Array<{ type: string; lines: Array<{ text: string }> }> };

  return structured.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.lines.map((line) => line.text).join('\n').trim())
    .filter((text) => text !== '');
}

/** Flatten a page to a single string with blank lines between blocks. */
export function pageText(doc: mupdf.PDFDocument, pageIndex: number): string {
  return pageBlocks(doc, pageIndex).join('\n\n');
}
