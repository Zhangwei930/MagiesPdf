import { escapeHtml, htmlThroughHost, pageSetupParams } from './htmlPipeline.ts';
import type { ToolDescriptor } from '../../types.ts';
import { soleFile } from '../shared.ts';

/**
 * Parse a single CSV line with basic RFC 4180 quoting (double-quote fields,
 * `""` escapes). Not a full spreadsheet parser — good enough for export files.
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function csvToHtmlTable(csv: string): string {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return '<p></p>';

  const rows = lines.map((line) => parseCsvLine(line));
  const [header, ...body] = rows;
  const thead = `<thead><tr>${(header ?? [])
    .map((cell) => `<th>${escapeHtml(cell)}</th>`)
    .join('')}</tr></thead>`;
  const tbody = `<tbody>${body
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}

export const csvToPdfTool: ToolDescriptor = {
  id: 'convert.csv-to-pdf',
  category: 'convert',
  name: { zh: 'CSV 转 PDF', en: 'CSV to PDF' },
  description: {
    zh: '把 CSV 表格排成干净的 PDF 表格，首行作为表头。',
    en: 'Typeset a CSV file as a clean PDF table, first row as the header.',
  },
  icon: 'Table',
  keywords: ['csv', 'table', 'spreadsheet', '表格', '逗号分隔'],
  input: { accept: ['.csv'], min: 1, max: 1 },
  output: 'single',
  params: pageSetupParams(),
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);
    const csv = new TextDecoder().decode(file.bytes);
    const body = csvToHtmlTable(csv);

    return htmlThroughHost(ctx, body, file.name, {
      zh: `已把「${file.name}」排版为 PDF 表格`,
      en: `Typeset "${file.name}" as a PDF table`,
    });
  },
};
