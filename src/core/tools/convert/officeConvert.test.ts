import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as XLSX from 'xlsx';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import type { HostBridge, HtmlToPdfOptions, ToolOutputFile } from '../../types.ts';
import { csvToHtmlTable, csvToPdfTool, parseCsvLine } from './csvToPdf.ts';
import { docxToHtml } from './docxToPdf.ts';
import { pdfToDocxTool } from './pdfToDocx.ts';
import { pdfToHtmlTool } from './pdfToHtml.ts';
import { textToPdfTool } from './textToPdf.ts';
import { xlsxToHtml, xlsxToPdfTool } from './xlsxToPdf.ts';

function mockHost(overrides: Partial<HostBridge> = {}): HostBridge & { lastHtml: string | null } {
  const host: HostBridge & { lastHtml: string | null } = {
    lastHtml: null,
    async htmlToPdf(html: string, _options: HtmlToPdfOptions) {
      host.lastHtml = html;
      const doc = await PDFDocument.create();
      const page = doc.addPage([595, 842]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText('ok', { x: 48, y: 780, size: 12, font });
      return doc.save({ useObjectStreams: false });
    },
    async externalConvert(): Promise<ToolOutputFile> {
      throw new Error('not configured');
    },
    hasExternalConverter: () => false,
    ...overrides,
  };
  return host;
}

describe('parseCsvLine', () => {
  it('splits plain cells', () => {
    assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  });

  it('handles quoted commas and escaped quotes', () => {
    assert.deepEqual(parseCsvLine('"a,b","c""d",e'), ['a,b', 'c"d', 'e']);
  });
});

describe('csvToHtmlTable', () => {
  it('uses the first row as a header', () => {
    const html = csvToHtmlTable('Name,Age\nAda,36\n');
    assert.ok(html.includes('<th>Name</th>'));
    assert.ok(html.includes('<td>Ada</td>'));
    assert.ok(html.includes('<td>36</td>'));
  });

  it('escapes cell content', () => {
    const html = csvToHtmlTable('x\n<a>');
    assert.ok(html.includes('&lt;a&gt;'));
    assert.ok(!html.includes('<a>'));
  });
});

describe('convert.text-to-pdf', () => {
  it('wraps plain text in a pre block and prints via host', async () => {
    const host = mockHost();
    const result = await executeTool(textToPdfTool, {
      files: [asInput(new TextEncoder().encode('line1\nline2'), 'notes.txt', 'text/plain')],
      params: {},
      host,
    });

    assert.equal(result.files[0]!.name, 'notes.pdf');
    assert.ok(host.lastHtml?.includes('<pre>line1\nline2</pre>'));
  });
});

describe('convert.csv-to-pdf', () => {
  it('sends a table through the host', async () => {
    const host = mockHost();
    const result = await executeTool(csvToPdfTool, {
      files: [asInput(new TextEncoder().encode('A,B\n1,2\n'), 'data.csv', 'text/csv')],
      params: {},
      host,
    });

    assert.equal(result.files[0]!.name, 'data.pdf');
    assert.ok(host.lastHtml?.includes('<table>'));
    assert.ok(host.lastHtml?.includes('<th>A</th>'));
  });
});

describe('xlsxToHtml', () => {
  it('renders each sheet as a headed table', async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Item', 'Qty'],
      ['Apples', 3],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Stock');
    const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

    const html = await xlsxToHtml(bytes);
    assert.ok(html.includes('<h2>Stock</h2>'));
    assert.ok(html.includes('Apples'));
  });

  it('rejects garbage', async () => {
    await assert.rejects(
      xlsxToHtml(new TextEncoder().encode('not xlsx')),
      (e: unknown) => e instanceof ToolError && e.code === 'CORRUPT_DOCUMENT',
    );
  });
});

describe('convert.xlsx-to-pdf', () => {
  it('converts a workbook via the host', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['H'], ['v']]),
      'S1',
    );
    const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    const host = mockHost();

    const result = await executeTool(xlsxToPdfTool, {
      files: [asInput(bytes, 'book.xlsx')],
      params: {},
      host,
    });

    assert.equal(result.files[0]!.name, 'book.pdf');
    assert.ok(host.lastHtml?.includes('S1'));
  });
});

describe('convert.pdf-to-html', () => {
  it('exports page text as HTML sections', async () => {
    const result = await executeTool(pdfToHtmlTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (n) => `P${n}` }), 'r.pdf')],
      params: {},
    });

    assert.equal(result.files[0]!.name, 'r.html');
    const html = new TextDecoder().decode(result.files[0]!.bytes);
    assert.ok(html.includes('data-page="1"'));
    assert.ok(html.includes('P1'));
    assert.ok(html.includes('P2'));
  });
});

describe('convert.pdf-to-docx', () => {
  it('prefers the configured external converter for high-fidelity output', async () => {
    let target = '';
    const expected = new Uint8Array([0x50, 0x4b, 3, 4]);
    const host = mockHost({
      hasExternalConverter: () => true,
      async externalConvert(_input, extension) {
        target = extension;
        return {
          name: `converted.${extension}`,
          bytes: expected,
          mime: 'application/octet-stream',
        };
      },
    });
    const result = await executeTool(pdfToDocxTool, {
      files: [asInput(await samplePdf({ pages: 1 }), 'report.pdf')],
      params: {},
      host,
    });

    assert.equal(target, 'docx');
    assert.deepEqual(result.files[0]!.bytes, expected);
  });

  it('produces a real docx that mammoth can re-read', async () => {
    const result = await executeTool(pdfToDocxTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (n) => `Page${n}` }), 'report.pdf')],
      params: {},
      host: mockHost(),
    });

    assert.equal(result.files[0]!.name, 'report.docx');
    assert.deepEqual([...result.files[0]!.bytes.slice(0, 2)], [0x50, 0x4b]);

    const { html } = await docxToHtml(result.files[0]!.bytes);
    assert.ok(html.includes('Page1'));
    assert.ok(html.includes('Page2'));
  });

  it('respects the page selection', async () => {
    const result = await executeTool(pdfToDocxTool, {
      files: [asInput(await samplePdf({ pages: 3, label: (n) => `X${n}` }), 'r.pdf')],
      params: { pages: '2' },
      host: mockHost(),
    });
    const { html } = await docxToHtml(result.files[0]!.bytes);
    assert.ok(html.includes('X2'));
    assert.ok(!html.includes('X1'));
  });
});
