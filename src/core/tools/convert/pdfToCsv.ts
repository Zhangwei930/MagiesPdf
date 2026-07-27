import { withDocumentSync } from '../../pdf/document.ts';
import { pageBlocks } from '../../pdf/text.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, resolvePages, soleFile, stringParam } from '../shared.ts';

/** Escape one CSV cell (RFC 4180-ish). */
export function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function rowsToCsv(rows: readonly string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export const pdfToCsvTool: ToolDescriptor = {
  id: 'convert.pdf-to-csv',
  category: 'convert',
  name: { zh: 'PDF 转 CSV', en: 'PDF to CSV' },
  description: {
    zh: '把文字按「页码 + 段落」导出为 CSV，方便在表格软件里再处理。',
    en: 'Export text as CSV (page + paragraph) for spreadsheet rework.',
  },
  icon: 'Table',
  keywords: ['csv', 'excel', 'table', 'export', 'spreadsheet', '表格', '导出'],
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
    {
      key: 'layout',
      type: 'select',
      label: { zh: '行粒度', en: 'Row granularity' },
      default: 'block',
      options: [
        { value: 'block', label: { zh: '每个段落一行', en: 'One row per paragraph' } },
        { value: 'line', label: { zh: '每个软换行一行', en: 'One row per soft line' } },
      ],
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const layout = stringParam(ctx, 'layout');

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const rows: string[][] = [['Page', 'Text']];

      for (const page of pages) {
        const blocks = pageBlocks(doc, page - 1);
        if (blocks.length === 0) {
          rows.push([String(page), '']);
          continue;
        }
        for (const block of blocks) {
          if (layout === 'line') {
            for (const line of block.split('\n')) {
              rows.push([String(page), line]);
            }
          } else {
            rows.push([String(page), block]);
          }
        }
      }

      const csv = rowsToCsv(rows);
      ctx.report(1);

      return {
        files: [
          {
            name: `${stemOf(file.name)}.csv`,
            bytes: new TextEncoder().encode(csv),
            mime: 'text/csv',
          },
        ],
        summary: {
          zh: `已导出 ${pages.length} 页为 CSV（${rows.length - 1} 行）`,
          en: `Exported ${pages.length} page(s) as CSV (${rows.length - 1} row(s))`,
        },
      };
    });
  },
};
