import type * as mupdf from 'mupdf';
import type { DocxParagraphSpec } from '../../ooxml/docx.ts';
import { paragraphsToDocx } from '../../ooxml/docx.ts';
import { withDocumentSync } from '../../pdf/document.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, resolvePages, soleFile, stringParam } from '../shared.ts';
import { externalOfficeExport } from './officeExternal.ts';

interface StructuredFont {
  name?: string;
  weight?: string;
  size?: number;
}

interface StructuredLine {
  text?: string;
  font?: StructuredFont;
}

interface StructuredBlock {
  type: string;
  lines: StructuredLine[];
}

function pageParagraphs(doc: mupdf.PDFDocument, pageIndex: number): DocxParagraphSpec[] {
  const structured = JSON.parse(
    doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asJSON(),
  ) as { blocks: StructuredBlock[] };

  const result: DocxParagraphSpec[] = [];

  for (const block of structured.blocks) {
    if (block.type !== 'text') continue;
    for (const line of block.lines) {
      const text = (line.text || '').trim();
      if (!text) continue;

      const size = line.font?.size || 11;
      const weight = line.font?.weight;
      const bold = weight === 'bold' || weight === 'semibold' || weight === '700';

      result.push({
        text,
        size,
        bold,
      });
    }
  }

  return result;
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
      const paragraphs: DocxParagraphSpec[] = [];

      for (let i = 0; i < pages.length; i += 1) {
        const page = pages[i] as number;
        if (i > 0) {
          paragraphs.push({ isPageBreak: true });
        }
        for (const p of pageParagraphs(doc, page - 1)) {
          paragraphs.push(p);
        }
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
