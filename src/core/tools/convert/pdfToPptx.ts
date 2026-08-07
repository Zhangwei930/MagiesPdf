import type * as mupdf from 'mupdf';
import { slidesToPptx } from '../../ooxml/pptx.ts';
import { withDocumentSync } from '../../pdf/document.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, resolvePages, soleFile, stringParam } from '../shared.ts';
import { externalOfficeExport } from './officeExternal.ts';

function extractSlideContent(doc: mupdf.PDFDocument, pageIndex: number): { title: string; body: string[] } {
  const structured = JSON.parse(
    doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asJSON(),
  ) as { blocks: Array<{ type: string; lines: Array<{ text: string }> }> };

  const lines: string[] = [];
  for (const block of structured.blocks) {
    if (block.type !== 'text') continue;
    for (const l of block.lines) {
      const text = (l.text || '').trim();
      if (text) lines.push(text);
    }
  }

  const title = lines[0]?.slice(0, 120) || `Slide ${pageIndex + 1}`;
  const body = lines.length > 0 ? lines : [''];
  return { title, body };
}

export const pdfToPptxTool: ToolDescriptor = {
  id: 'convert.pdf-to-pptx',
  category: 'convert',
  name: { zh: 'PDF 转 PPT', en: 'PDF to PowerPoint' },
  description: {
    zh: '每页做成一张幻灯片，提取文字进标题/正文。版式会简化，适合二次编辑。',
    en: 'One slide per page with extracted text. Layout is simplified — good for re-editing.',
  },
  icon: 'GalleryVertical',
  keywords: ['powerpoint', 'pptx', 'slides', 'export', '演示', '幻灯片', '导出'],
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
    const external = await externalOfficeExport(ctx, file, 'pptx');
    if (external) return external;

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const slides = pages.map((page) => extractSlideContent(doc, page - 1));

      const bytes = slidesToPptx(slides);
      ctx.report(1);

      return {
        files: [
          {
            name: `${stemOf(file.name)}.pptx`,
            bytes,
            mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          },
        ],
        summary: {
          zh: `已导出 ${pages.length} 页为 ${pages.length} 张幻灯片`,
          en: `Exported ${pages.length} page(s) as ${pages.length} slide(s)`,
        },
      };
    });
  },
};
