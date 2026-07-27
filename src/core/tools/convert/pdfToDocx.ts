import type * as mupdf from 'mupdf';
import { paragraphsToDocx } from '../../ooxml/docx.ts';
import { withDocumentSync } from '../../pdf/document.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, resolvePages, soleFile, stringParam } from '../shared.ts';
import { externalOfficeExport } from './officeExternal.ts';

function pageBlocks(doc: mupdf.PDFDocument, pageIndex: number): string[] {
  const structured = JSON.parse(
    doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asJSON(),
  ) as { blocks: Array<{ type: string; lines: Array<{ text: string }> }> };

  return structured.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.lines.map((line) => line.text).join('\n').trim())
    .filter((text) => text !== '');
}

export const pdfToDocxTool: ToolDescriptor = {
  id: 'convert.pdf-to-docx',
  category: 'convert',
  name: { zh: 'PDF 转 Word', en: 'PDF to Word' },
  description: {
    zh: '提取文字生成可编辑的 .docx。保留段落结构，不追求版式还原。',
    en: 'Extract text into an editable .docx. Paragraphs survive; pixel-perfect layout does not.',
  },
  icon: 'FileText',
  keywords: ['word', 'docx', 'office', 'export', '文档', '导出'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'pages',
      type: 'pageRange',
      label: { zh: '页码范围', en: 'Pages' },
      default: 'all',
      required: true,
    },
    passwordParam(),
  ],
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);
    const external = await externalOfficeExport(ctx, file, 'docx');
    if (external) return external;

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const paragraphs: string[] = [];

      for (let i = 0; i < pages.length; i += 1) {
        const page = pages[i] as number;
        for (const block of pageBlocks(doc, page - 1)) {
          paragraphs.push(block);
        }
        // Blank paragraph between pages so Word readers see a soft break.
        if (i < pages.length - 1) paragraphs.push('');
      }

      const bytes = paragraphsToDocx(paragraphs);
      ctx.report(1);

      return {
        files: [
          {
            name: `${stemOf(file.name)}.docx`,
            bytes,
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        ],
        summary: {
          zh: `已导出 ${pages.length} 页为 Word 文档`,
          en: `Exported ${pages.length} pages as a Word document`,
        },
      };
    });
  },
};
