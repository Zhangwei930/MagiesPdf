import { ToolError } from '../../errors.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { htmlThroughHost, pageSetupParams } from './htmlPipeline.ts';
import { pdfOutput, soleFile } from '../shared.ts';

/** Workbook → printable HTML via SheetJS. Exported for host-free unit tests. */
export async function xlsxToHtml(bytes: Uint8Array): Promise<string> {
  // SheetJS will invent a single-cell sheet from arbitrary bytes; refuse early.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ToolError('CORRUPT_DOCUMENT', 'Not a ZIP-based .xlsx package', {
      zh: '无法解析这个 Excel 文件——文件可能已损坏，或是老式 .xls 格式。',
      en: 'This spreadsheet could not be parsed — it may be damaged, or a legacy .xls file.',
    });
  }

  const XLSX = await import('xlsx');
  let workbook: ReturnType<typeof XLSX.read>;
  try {
    workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
  } catch (cause) {
    throw new ToolError(
      'CORRUPT_DOCUMENT',
      `xlsx parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        zh: '无法解析这个 Excel 文件——文件可能已损坏，或是老式 .xls 格式。',
        en: 'This spreadsheet could not be parsed — it may be damaged, or a legacy .xls file.',
      },
    );
  }

  if (workbook.SheetNames.length === 0) {
    throw new ToolError('EMPTY_RESULT', 'Workbook has no sheets', {
      zh: '这个工作簿里没有工作表。',
      en: 'This workbook has no sheets.',
    });
  }

  const sections = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return '';
    const table = XLSX.utils.sheet_to_html(sheet, { id: '', editable: false });
    // sheet_to_html wraps a full document; pull just the table.
    const match = table.match(/<table[\s\S]*?<\/table>/i);
    const tableHtml = match?.[0] ?? table;
    return `<h2>${escapeSheetName(name)}</h2>\n${tableHtml}`;
  }).filter(Boolean);

  return sections.join('\n');
}

function escapeSheetName(name: string): string {
  return name
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export const xlsxToPdfTool: ToolDescriptor = {
  id: 'convert.xlsx-to-pdf',
  category: 'convert',
  name: { zh: 'Excel 转 PDF', en: 'Excel to PDF' },
  description: {
    zh: '把 .xlsx 工作簿转成 PDF。检测到 LibreOffice 时自动使用本地办公引擎。',
    en: 'Convert an .xlsx workbook to PDF. Automatically uses the local LibreOffice engine when available.',
  },
  icon: 'Table',
  keywords: ['excel', 'xlsx', 'spreadsheet', '表格', '工作簿', '转换'],
  input: { accept: ['.xlsx'], min: 1, max: 1 },
  output: 'single',
  params: pageSetupParams(),
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);

    if (ctx.host?.hasExternalConverter('pdf')) {
      const output = await ctx.host.externalConvert(file, 'pdf', ctx.signal);
      ctx.report(1);
      return {
        files: [pdfOutput(suffixedName(file.name, '', '.pdf'), output.bytes)],
        summary: {
          zh: `已通过本地办公引擎转换「${file.name}」`,
          en: `Converted "${file.name}" via the local Office engine`,
        },
      };
    }

    const html = await xlsxToHtml(file.bytes);
    return htmlThroughHost(ctx, html, file.name, {
      zh: `已转换「${file.name}」`,
      en: `Converted "${file.name}"`,
    });
  },
};
