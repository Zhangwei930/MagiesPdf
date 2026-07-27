import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';
import { PDFDocument } from 'pdf-lib';
import { executeTool } from '../../execute.ts';
import { extractPptxSlideTexts } from '../../ooxml/pptx.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import type { HostBridge, HtmlToPdfOptions, ToolOutputFile } from '../../types.ts';
import { pdfToPptxTool } from './pdfToPptx.ts';
import { pdfToXlsxTool } from './pdfToXlsx.ts';
import { pptxToPdfTool, slidesToHtml } from './pptxToPdf.ts';

function mockHost(): HostBridge & { lastHtml: string | null } {
  const host: HostBridge & { lastHtml: string | null } = {
    lastHtml: null,
    async htmlToPdf(html: string, _options: HtmlToPdfOptions) {
      host.lastHtml = html;
      const doc = await PDFDocument.create();
      doc.addPage();
      return doc.save({ useObjectStreams: false });
    },
    async externalConvert(): Promise<ToolOutputFile> {
      throw new Error('not configured');
    },
    hasExternalConverter: () => false,
  };
  return host;
}

describe('convert.pdf-to-xlsx', () => {
  it('writes a workbook with page and text columns', async () => {
    const result = await executeTool(pdfToXlsxTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (n) => `Cell${n}` }), 'r.pdf')],
      params: {},
      host: mockHost(),
    });

    assert.equal(result.files[0]!.name, 'r.xlsx');
    const workbook = XLSX.read(result.files[0]!.bytes, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    assert.ok(sheetName);
    const sheet = workbook.Sheets[sheetName];
    assert.ok(sheet);
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
    assert.deepEqual(rows[0], ['Page', 'Text']);
    const flat = rows.map((row) => row.join(' ')).join(' ');
    assert.ok(flat.includes('Cell1'));
    assert.ok(flat.includes('Cell2'));
  });

  it('can put each page on its own sheet', async () => {
    const result = await executeTool(pdfToXlsxTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (n) => `P${n}` }), 'r.pdf')],
      params: { layout: 'perPage' },
      host: mockHost(),
    });
    const workbook = XLSX.read(result.files[0]!.bytes, { type: 'array' });
    assert.equal(workbook.SheetNames.length, 2);
  });
});

describe('convert.pdf-to-pptx', () => {
  it('creates one slide per page with readable text', async () => {
    const result = await executeTool(pdfToPptxTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (n) => `SlideLabel${n}` }), 'deck.pdf')],
      params: {},
      host: mockHost(),
    });

    assert.equal(result.files[0]!.name, 'deck.pptx');
    const texts = extractPptxSlideTexts(result.files[0]!.bytes);
    assert.equal(texts.length, 2);
    assert.ok(texts[0]?.includes('SlideLabel1'));
    assert.ok(texts[1]?.includes('SlideLabel2'));
  });
});

describe('slidesToHtml', () => {
  it('escapes content and numbers slides', () => {
    const html = slidesToHtml(['A&B', '']);
    assert.ok(html.includes('data-slide="1"'));
    assert.ok(html.includes('A&amp;B'));
    assert.ok(html.includes('data-slide="2"'));
  });
});

describe('convert.pptx-to-pdf', () => {
  it('sends extracted slide HTML through the host', async () => {
    // Build a pptx via the export tool, then convert back.
    const pptx = await executeTool(pdfToPptxTool, {
      files: [asInput(await samplePdf({ pages: 1, label: () => 'HelloDeck' }), 'x.pdf')],
      params: {},
      host: mockHost(),
    });
    const host = mockHost();
    const result = await executeTool(pptxToPdfTool, {
      files: [asInput(pptx.files[0]!.bytes, 'x.pptx')],
      params: {},
      host,
    });

    assert.equal(result.files[0]!.name, 'x.pdf');
    assert.ok(host.lastHtml?.includes('HelloDeck'));
  });
});
