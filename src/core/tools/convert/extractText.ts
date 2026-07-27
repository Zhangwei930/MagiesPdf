import type * as mupdf from 'mupdf';
import { withDocumentSync } from '../../pdf/document.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  boolParam,
  passwordParam,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

/** Extracts the text of one page, blocks separated by blank lines. */
function pageBlocks(doc: mupdf.PDFDocument, pageIndex: number): string[] {
  const structured = JSON.parse(
    doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asJSON(),
  ) as { blocks: Array<{ type: string; lines: Array<{ text: string }> }> };

  return structured.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.lines.map((line) => line.text).join('\n').trim())
    .filter((text) => text !== '');
}

export const pdfToTextTool: ToolDescriptor = {
  id: 'convert.pdf-to-text',
  category: 'convert',
  name: { zh: 'PDF 转文本', en: 'PDF to Text' },
  description: {
    zh: '提取全部文字内容，保存为纯文本文件。',
    en: 'Extract all text content into a plain .txt file.',
  },
  icon: 'FileText',
  keywords: ['text', 'txt', 'extract', 'copy', '文本', '文字', '提取文字'],
  input: PDF_ONE,
  output: 'single',
  params: [
    pageRange(),
    {
      key: 'pageBreaks',
      type: 'boolean',
      label: { zh: '页与页之间插入分页符', en: 'Insert form feeds between pages' },
      help: {
        zh: '分页符（U+000C）能让下游工具知道分页位置。',
        en: 'A form feed (U+000C) lets downstream tools see the page boundaries.',
      },
      default: false,
      advanced: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const separator = boolParam(ctx, 'pageBreaks') ? '\n\f\n' : '\n\n';

      const text = pages
        .map((page) => pageBlocks(doc, page - 1).join('\n\n'))
        .join(separator);
      ctx.report(1);

      return {
        files: [
          {
            name: `${stemOf(file.name)}.txt`,
            bytes: new TextEncoder().encode(text),
            mime: 'text/plain',
          },
        ],
        summary: {
          zh: `已从 ${pages.length} 页提取 ${[...text].length} 个字符`,
          en: `Extracted ${[...text].length} characters from ${pages.length} pages`,
        },
      };
    });
  },
};

export const pdfToMarkdownTool: ToolDescriptor = {
  id: 'convert.pdf-to-markdown',
  category: 'convert',
  name: { zh: 'PDF 转 Markdown', en: 'PDF to Markdown' },
  description: {
    zh: '把文字内容导出为 Markdown，段落分明，页与页之间用分隔线。',
    en: 'Export the text as Markdown — clean paragraphs, a rule between pages.',
  },
  icon: 'FileCode',
  keywords: ['markdown', 'md', 'export', 'notes', '笔记', '导出'],
  input: PDF_ONE,
  output: 'single',
  params: [pageRange(), passwordParam()],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const pages = resolvePages(ctx, 'pages', doc.countPages());

      const markdown = pages
        .map((page) =>
          pageBlocks(doc, page - 1)
            // Markdown treats single newlines as soft; keep blocks as paragraphs.
            .map((block) => block.replace(/\n/g, ' '))
            .join('\n\n'),
        )
        .join('\n\n---\n\n');
      ctx.report(1);

      return {
        files: [
          {
            name: `${stemOf(file.name)}.md`,
            bytes: new TextEncoder().encode(`${markdown}\n`),
            mime: 'text/markdown',
          },
        ],
        summary: {
          zh: `已导出 ${pages.length} 页为 Markdown`,
          en: `Exported ${pages.length} pages as Markdown`,
        },
      };
    });
  },
};

function pageRange() {
  return {
    key: 'pages',
    type: 'pageRange' as const,
    label: { zh: '页码范围', en: 'Pages' },
    default: 'all',
    required: true,
  };
}
