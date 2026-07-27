import * as XLSX from 'xlsx';
import { withDocumentSync } from '../../pdf/document.ts';
import { pageBlocks } from '../../pdf/text.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, resolvePages, soleFile, stringParam } from '../shared.ts';
import { externalOfficeExport } from './officeExternal.ts';

export const pdfToXlsxTool: ToolDescriptor = {
  id: 'convert.pdf-to-xlsx',
  category: 'convert',
  name: { zh: 'PDF 转 Excel', en: 'PDF to Excel' },
  description: {
    zh: '把文字内容导出为 .xlsx 表格（页码 + 段落）。适合再加工，不还原原表结构。',
    en: 'Export text into an .xlsx sheet (page + paragraph). Good for rework — not a table reconstructor.',
  },
  icon: 'Table',
  keywords: ['excel', 'xlsx', 'spreadsheet', 'export', '表格', '导出'],
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
      label: { zh: '工作表布局', en: 'Sheet layout' },
      default: 'single',
      options: [
        {
          value: 'single',
          label: { zh: '全部页在一张表', en: 'All pages in one sheet' },
        },
        {
          value: 'perPage',
          label: { zh: '每页一张表', en: 'One sheet per page' },
        },
      ],
    },
    passwordParam(),
  ],
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);
    const external = await externalOfficeExport(ctx, file, 'xlsx');
    if (external) return external;

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const layout = stringParam(ctx, 'layout');
      const workbook = XLSX.utils.book_new();

      if (layout === 'perPage') {
        for (const page of pages) {
          const rows: string[][] = [['Text']];
          for (const block of pageBlocks(doc, page - 1)) {
            rows.push([block]);
          }
          if (rows.length === 1) rows.push(['']);
          const sheet = XLSX.utils.aoa_to_sheet(rows);
          // Sheet names max 31 chars; keep unique.
          const name = `Page ${page}`.slice(0, 31);
          XLSX.utils.book_append_sheet(workbook, sheet, name);
        }
      } else {
        const rows: Array<string | number>[] = [['Page', 'Text']];
        for (const page of pages) {
          const blocks = pageBlocks(doc, page - 1);
          if (blocks.length === 0) {
            rows.push([page, '']);
          } else {
            for (const block of blocks) rows.push([page, block]);
          }
        }
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Extract');
      }

      const bytes = new Uint8Array(
        XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
      );
      ctx.report(1);

      return {
        files: [
          {
            name: `${stemOf(file.name)}.xlsx`,
            bytes,
            mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
        ],
        summary: {
          zh: `已导出 ${pages.length} 页为 Excel`,
          en: `Exported ${pages.length} pages as Excel`,
        },
      };
    });
  },
};
