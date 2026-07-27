import type * as mupdf from 'mupdf';
import { withDocumentSync } from '../../pdf/document.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, resolvePages, soleFile, stringParam } from '../shared.ts';
import { escapeHtml } from './htmlPipeline.ts';

function pageBlocks(doc: mupdf.PDFDocument, pageIndex: number): string[] {
  const structured = JSON.parse(
    doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asJSON(),
  ) as { blocks: Array<{ type: string; lines: Array<{ text: string }> }> };

  return structured.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.lines.map((line) => line.text).join('\n').trim())
    .filter((text) => text !== '');
}

export const pdfToHtmlTool: ToolDescriptor = {
  id: 'convert.pdf-to-html',
  category: 'convert',
  name: { zh: 'PDF 转 HTML', en: 'PDF to HTML' },
  description: {
    zh: '提取文字内容为干净的 HTML，每页一个区块，便于二次编辑或发布。',
    en: 'Export the text as clean HTML — one section per page, ready to edit or publish.',
  },
  icon: 'Globe',
  keywords: ['html', 'web', 'export', '网页', '导出'],
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
      const sections = pages.map((page) => {
        const paragraphs = pageBlocks(doc, page - 1)
          .map((block) => `<p>${escapeHtml(block).replaceAll('\n', '<br>')}</p>`)
          .join('\n');
        return `<section data-page="${page}">\n${paragraphs || '<p></p>'}\n</section>`;
      });

      const html = [
        '<!doctype html>',
        '<html lang="und">',
        '<head>',
        '<meta charset="utf-8">',
        `<title>${escapeHtml(stemOf(file.name))}</title>`,
        '<style>body{font-family:system-ui,sans-serif;line-height:1.6;max-width:48rem;margin:2rem auto;padding:0 1rem}section{margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid #ddd}</style>',
        '</head>',
        `<body>\n${sections.join('\n')}\n</body>`,
        '</html>',
        '',
      ].join('\n');

      ctx.report(1);

      return {
        files: [
          {
            name: `${stemOf(file.name)}.html`,
            bytes: new TextEncoder().encode(html),
            mime: 'text/html',
          },
        ],
        summary: {
          zh: `已导出 ${pages.length} 页为 HTML`,
          en: `Exported ${pages.length} pages as HTML`,
        },
      };
    });
  },
};
