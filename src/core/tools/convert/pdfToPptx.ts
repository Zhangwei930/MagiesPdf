import { slidesToPptx } from '../../ooxml/pptx.ts';
import { withDocumentSync } from '../../pdf/document.ts';
import { pageBlocks } from '../../pdf/text.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, resolvePages, soleFile, stringParam } from '../shared.ts';

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
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const slides = pages.map((page) => {
        const blocks = pageBlocks(doc, page - 1);
        const title = blocks[0]?.split('\n')[0]?.slice(0, 120) || `Page ${page}`;
        const body = blocks.length > 0 ? blocks : [''];
        // If the first block became the title, keep it in body too when it was multi-line.
        return { title, body };
      });

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
