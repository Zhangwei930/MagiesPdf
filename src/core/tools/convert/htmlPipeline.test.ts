import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { asInput } from '../../testing/fixtures.ts';
import type { HostBridge, HtmlToPdfOptions, ToolInputFile, ToolOutputFile } from '../../types.ts';
import { docxToHtml, docxToPdfTool } from './docxToPdf.ts';
import {
  escapeHtml,
  pageSetupOf,
  wrapHtmlDocument,
} from './htmlPipeline.ts';
import { htmlToPdfTool } from './htmlToPdf.ts';
import { markdownToPdfTool } from './markdownToPdf.ts';

/** A host that records the HTML it was asked to print and returns a real PDF. */
function mockHost(overrides: Partial<HostBridge> = {}): HostBridge & {
  lastHtml: string | null;
  lastOptions: HtmlToPdfOptions | null;
  lastSignal: AbortSignal | null;
} {
  const host: HostBridge & {
    lastHtml: string | null;
    lastOptions: HtmlToPdfOptions | null;
    lastSignal: AbortSignal | null;
  } = {
    lastHtml: null,
    lastOptions: null,
    lastSignal: null,
    async htmlToPdf(html, options, signal?: AbortSignal) {
      host.lastHtml = html;
      host.lastOptions = options;
      host.lastSignal = signal ?? null;
      // Produce a real one-page PDF so callers can open the result.
      const doc = await PDFDocument.create();
      const page = doc.addPage([595, 842]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText('printed', { x: 48, y: 780, size: 18, font });
      return doc.save({ useObjectStreams: false });
    },
    async externalConvert(_input, targetExtension): Promise<ToolOutputFile> {
      return {
        name: `out.${targetExtension}`,
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'application/pdf',
      };
    },
    hasExternalConverter() {
      return false;
    },
    ...overrides,
  };

  return host;
}

function textFile(text: string, name: string, mime: string): ToolInputFile {
  return asInput(new TextEncoder().encode(text), name, mime);
}

describe('escapeHtml / wrapHtmlDocument', () => {
  it('escapes the five characters that would break markup', () => {
    assert.equal(escapeHtml(`a&b<c>d"e`), 'a&amp;b&lt;c&gt;d&quot;e');
  });

  it('builds a complete printable document around body HTML', () => {
    const html = wrapHtmlDocument('<p>你好</p>', 'notes.md');
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('<title>notes.md</title>'));
    assert.ok(html.includes('<p>你好</p>'));
    assert.ok(html.includes('PingFang SC'));
  });

  it('escapes the title so a malicious filename cannot inject markup', () => {
    const html = wrapHtmlDocument('<p>x</p>', 'a</title><script>alert(1)</script>');
    assert.ok(html.includes('a&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('</title><script>'));
  });
});

describe('convert.markdown-to-pdf', () => {
  it('refuses to run without a host bridge', async () => {
    await assert.rejects(
      executeTool(markdownToPdfTool, {
        files: [textFile('# Hi', 'notes.md', 'text/markdown')],
        params: {},
      }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'HOST_UNAVAILABLE');
        return true;
      },
    );
  });

  it('sends GFM-rendered HTML through the host and returns a PDF', async () => {
    const host = mockHost();
    const controller = new AbortController();
    const result = await executeTool(markdownToPdfTool, {
      files: [textFile('# Title\n\nHello **world**', 'notes.md', 'text/markdown')],
      params: { pageSize: 'Letter', landscape: true, marginInches: 0.5 },
      host,
      signal: controller.signal,
    });

    assert.equal(result.files[0]!.name, 'notes.pdf');
    assert.equal(result.files[0]!.mime, 'application/pdf');
    assert.ok(host.lastHtml?.includes('<h1'));
    assert.ok(host.lastHtml?.includes('Hello'));
    assert.ok(host.lastHtml?.includes('<strong>world</strong>'));
    assert.equal(host.lastOptions?.pageSize, 'Letter');
    assert.equal(host.lastOptions?.landscape, true);
    assert.equal(host.lastOptions?.margins.top, 0.5);
    assert.equal(host.lastSignal, controller.signal);

    const opened = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(opened.countPages(), 1);
    } finally {
      opened.destroy();
    }
  });
});

describe('convert.html-to-pdf', () => {
  it('prints the user HTML as-is (no MagiesPdf shell)', async () => {
    const host = mockHost();
    const source = '<!doctype html><html><body><h1>Raw</h1></body></html>';
    const result = await executeTool(htmlToPdfTool, {
      files: [textFile(source, 'page.html', 'text/html')],
      params: {},
      host,
    });

    assert.equal(result.files[0]!.name, 'page.pdf');
    assert.equal(host.lastHtml, source);
  });
});

describe('docxToHtml', () => {
  it('extracts body HTML from a minimal .docx', async () => {
    const bytes = await minimalDocx('Hello from Word');
    const { html } = await docxToHtml(bytes);
    assert.ok(html.includes('Hello from Word'));
  });

  it('rejects garbage that is not a docx', async () => {
    await assert.rejects(
      docxToHtml(new TextEncoder().encode('not a zip')),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'CORRUPT_DOCUMENT');
        return true;
      },
    );
  });
});

describe('convert.docx-to-pdf', () => {
  it('uses the built-in path when no external converter is configured', async () => {
    const host = mockHost({ hasExternalConverter: () => false });
    const result = await executeTool(docxToPdfTool, {
      files: [asInput(await minimalDocx('Body text'), 'letter.docx')],
      params: {},
      host,
    });

    assert.equal(result.files[0]!.name, 'letter.pdf');
    assert.ok(host.lastHtml?.includes('Body text'));
  });

  it('prefers the external converter when one is configured', async () => {
    let called = false;
    let receivedSignal: AbortSignal | undefined;
    const host = mockHost({
      hasExternalConverter: () => true,
      async externalConvert(input, ext, signal?: AbortSignal) {
        called = true;
        receivedSignal = signal;
        assert.equal(input.name, 'letter.docx');
        assert.equal(ext, 'pdf');
        const doc = await PDFDocument.create();
        doc.addPage();
        return {
          name: 'letter.pdf',
          bytes: await doc.save({ useObjectStreams: false }),
          mime: 'application/pdf',
        };
      },
    });

    const controller = new AbortController();
    const result = await executeTool(docxToPdfTool, {
      files: [asInput(await minimalDocx('x'), 'letter.docx')],
      params: {},
      host,
      signal: controller.signal,
    });

    assert.ok(called);
    assert.equal(receivedSignal, controller.signal);
    assert.equal(result.files[0]!.name, 'letter.pdf');
    assert.equal(host.lastHtml, null, 'built-in path must not run when external is used');
  });
});

describe('pageSetupOf', () => {
  it('reads page size, landscape and equal margins from params', () => {
    const options = pageSetupOf({
      files: [],
      params: { pageSize: 'A5', landscape: true, marginInches: 1 },
      signal: new AbortController().signal,
      report() {},
    });
    assert.deepEqual(options, {
      pageSize: 'A5',
      landscape: true,
      margins: { top: 1, bottom: 1, left: 1, right: 1 },
      printBackground: true,
    });
  });
});

/**
 * Builds a tiny valid .docx (Office Open XML) with a single paragraph of text.
 * Uncompressed ZIP so we need no extra dependency — enough for mammoth to parse.
 */
async function minimalDocx(text: string): Promise<Uint8Array> {
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body><w:p><w:r><w:t>',
    escapeXml(text),
    '</w:t></w:r></w:p></w:body></w:document>',
  ].join('');

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join('');

  const rels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join('');

  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
  ]);
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Minimal ZIP writer (store method only). */
function zipStore(entries: { name: string; data: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = encoder.encode(entry.data);
    const crc = crc32(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true); // store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total =
    locals.reduce((n, l) => n + l.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const local of locals) {
    out.set(local, pos);
    pos += local.length;
  }
  for (const central of centrals) {
    out.set(central, pos);
    pos += central.length;
  }
  out.set(end, pos);
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
