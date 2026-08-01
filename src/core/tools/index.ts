import { registry } from '../registry.ts';
import type { ToolDescriptor } from '../types.ts';

import { extractPagesTool } from './organize/extractPages.ts';
import { mergeTool } from './organize/merge.ts';
import { removePagesTool } from './organize/removePages.ts';
import { reorderTool } from './organize/reorder.ts';
import { rotateTool } from './organize/rotate.ts';
import { splitTool } from './organize/split.ts';
import { cropTool } from './organize/crop.ts';
import { nUpTool } from './organize/nUp.ts';
import { overlayPdfTool } from './organize/overlayPdf.ts';
import { removeBlankTool } from './organize/removeBlank.ts';
import { scalePagesTool } from './organize/scalePages.ts';
import { singlePageTool } from './organize/singlePage.ts';
import { splitByChaptersTool } from './organize/splitByChapters.ts';
import { imageToPdfTool } from './convert/imageToPdf.ts';
import { pdfToImageTool } from './convert/pdfToImage.ts';
import { pdfToMarkdownTool, pdfToTextTool } from './convert/extractText.ts';
import { docxToPdfTool } from './convert/docxToPdf.ts';
import { htmlToPdfTool } from './convert/htmlToPdf.ts';
import { markdownToPdfTool } from './convert/markdownToPdf.ts';
import { textToPdfTool } from './convert/textToPdf.ts';
import { csvToPdfTool } from './convert/csvToPdf.ts';
import { xlsxToPdfTool } from './convert/xlsxToPdf.ts';
import { pdfToHtmlTool } from './convert/pdfToHtml.ts';
import { pdfToDocxTool } from './convert/pdfToDocx.ts';
import { pdfToXlsxTool } from './convert/pdfToXlsx.ts';
import { pdfToPptxTool } from './convert/pdfToPptx.ts';
import { pdfToCsvTool } from './convert/pdfToCsv.ts';
import { pptxToPdfTool } from './convert/pptxToPdf.ts';
import { createBlankTool } from './edit/createBlank.ts';
import { addTextTool } from './edit/addText.ts';
import { grayscaleTool } from './edit/grayscale.ts';
import { addHeaderFooterTool } from './edit/headerFooter.ts';
import { addPageNumbersTool } from './edit/pageNumbers.ts';
import { extractImagesTool } from './edit/extractImages.ts';
import { getInfoTool } from './edit/getInfo.ts';
import { ocrTool } from './edit/ocr.ts';
import { repairTool } from './edit/repair.ts';
import { addAttachmentsTool, extractAttachmentsTool } from './edit/attachments.ts';
import { addStampTool } from './edit/stamp.ts';
import { bookmarksTool } from './edit/bookmarks.ts';
import { compareTool } from './edit/compare.ts';
import { showJavascriptTool } from './security/showJavascript.ts';
import { compressTool } from './edit/compress.ts';
import { fillFormTool } from './edit/fillForm.ts';
import { addPasswordTool, removePasswordTool } from './security/password.ts';
import { addWatermarkTool } from './security/watermark.ts';
import { editMetadataTool, removeMetadataTool } from './security/metadata.ts';
import { flattenTool } from './security/flatten.ts';
import { sanitizeTool } from './security/sanitize.ts';
import { redactTool } from './security/redact.ts';
import { addSignatureTool } from './security/sign.ts';
import { certificateSignTool } from './security/certificateSign.ts';
import { inspectSignaturesTool } from './security/inspectSignatures.ts';
import { pipelineTool } from './advanced/pipeline.ts';
import { batchTool } from './advanced/batch.ts';

/**
 * The tool catalogue.
 *
 * Registration is explicit rather than glob-based so the bundle is statically
 * analysable and the order on the home screen is intentional. Adding a tool
 * means importing it here — the card grid, ⌘K search, pipeline palette and REST
 * routes all pick it up automatically from the registry.
 */
export const ALL_TOOLS: readonly ToolDescriptor[] = [
  // Organize
  mergeTool,
  splitTool,
  extractPagesTool,
  removePagesTool,
  reorderTool,
  rotateTool,
  splitByChaptersTool,
  removeBlankTool,
  cropTool,
  scalePagesTool,
  nUpTool,
  singlePageTool,
  overlayPdfTool,

  // Convert
  pdfToImageTool,
  imageToPdfTool,
  pdfToTextTool,
  pdfToMarkdownTool,
  pdfToHtmlTool,
  pdfToDocxTool,
  pdfToXlsxTool,
  pdfToPptxTool,
  pdfToCsvTool,
  markdownToPdfTool,
  htmlToPdfTool,
  textToPdfTool,
  csvToPdfTool,
  docxToPdfTool,
  xlsxToPdfTool,
  pptxToPdfTool,

  // Security
  addPasswordTool,
  removePasswordTool,
  addWatermarkTool,
  addSignatureTool,
  certificateSignTool,
  inspectSignaturesTool,
  redactTool,
  sanitizeTool,
  flattenTool,
  editMetadataTool,
  removeMetadataTool,
  showJavascriptTool,

  // Edit
  createBlankTool,
  addTextTool,
  compressTool,
  repairTool,
  ocrTool,
  grayscaleTool,
  addPageNumbersTool,
  addHeaderFooterTool,
  extractImagesTool,
  addStampTool,
  extractAttachmentsTool,
  addAttachmentsTool,
  bookmarksTool,
  compareTool,
  fillFormTool,
  getInfoTool,

  // Advanced
  pipelineTool,
  batchTool,
];

let registered = false;

/** Idempotent: the worker, the renderer and the tests each call this on start-up. */
export function registerAllTools(): void {
  if (registered) return;
  for (const tool of ALL_TOOLS) registry.register(tool);
  registered = true;
}

registerAllTools();

export { registry };
