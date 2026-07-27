import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { allPageText, asInput, encryptPdf, samplePdf } from '../../testing/fixtures.ts';
import { extractImagesTool, findImages } from './extractImages.ts';
import { formatPdfDate, getInfoTool, type ReportRow } from './getInfo.ts';
import { repairTool } from './repair.ts';

const doc = async (pages: number) =>
  asInput(await samplePdf({ pages, label: (n) => `P${n}` }), 'report.pdf');

/** A PDF with one embedded JPEG and one embedded PNG-backed (Flate) image. */
async function pdfWithImages(): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const source = openDocument(await samplePdf({ pages: 1 }));
  let jpg: Uint8Array;
  let png: Uint8Array;
  try {
    jpg = renderPage(source, 0, { dpi: 36, format: 'jpeg' }).bytes;
    png = renderPage(source, 0, { dpi: 36, format: 'png' }).bytes;
  } finally {
    source.destroy();
  }

  const out = await PDFDocument.create();
  const page = out.addPage([595, 842]);
  const jpgImage = await out.embedJpg(jpg);
  const pngImage = await out.embedPng(png);
  page.drawImage(jpgImage, { x: 20, y: 500, width: 200, height: 280 });
  page.drawImage(pngImage, { x: 250, y: 500, width: 200, height: 280 });
  return out.save();
}

describe('edit.repair', () => {
  it('recovers a document whose xref has been destroyed', async () => {
    const intact = await samplePdf({ pages: 3, label: (n) => `P${n}` });
    // Chop off the trailer + xref: byte-wise this is a classic truncation.
    const broken = intact.slice(0, intact.length - 180);

    const result = await executeTool(repairTool, {
      files: [asInput(broken, 'broken.pdf')],
      params: {},
    });

    assert.equal(result.files[0]!.name, 'broken_repaired.pdf');
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P2', 'P3']);
  });

  it('passes an already-healthy document through unchanged in content', async () => {
    const result = await executeTool(repairTool, { files: [await doc(2)], params: {} });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P2']);
  });

  it('reports an unrecoverable file as corrupt', async () => {
    await assert.rejects(
      executeTool(repairTool, {
        files: [asInput(new TextEncoder().encode('%PDF-1.7\ngarbage'), 'x.pdf')],
        params: {},
      }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'CORRUPT_DOCUMENT');
        return true;
      },
    );
  });
});

describe('formatPdfDate', () => {
  it('formats a full D: date', () => {
    assert.equal(formatPdfDate('D:20260727140256Z'), '2026-07-27 14:02:56');
  });

  it('fills missing components', () => {
    assert.equal(formatPdfDate('D:2026'), '2026-01-01 00:00:00');
  });

  it('passes junk through untouched', () => {
    assert.equal(formatPdfDate('yesterday'), 'yesterday');
  });
});

describe('edit.get-info', () => {
  const rowsOf = (data: unknown) => data as ReportRow[];
  const valueOf = (rows: ReportRow[], zhLabel: string) =>
    rows.find((r) => r.label.zh === zhLabel)?.value;

  it('reports pages, size and format as labelled rows', async () => {
    const result = await executeTool(getInfoTool, { files: [await doc(3)], params: {} });

    assert.equal(result.files.length, 0);
    const rows = rowsOf(result.data);
    assert.equal(valueOf(rows, '页数'), '3');
    assert.equal(valueOf(rows, '文件名'), 'report.pdf');
    assert.match(valueOf(rows, '格式版本') ?? '', /^PDF/);
    assert.match(valueOf(rows, '页面尺寸') ?? '', /595 × 842/);
  });

  it('shows metadata written by the producer', async () => {
    const result = await executeTool(getInfoTool, { files: [await doc(1)], params: {} });
    const rows = rowsOf(result.data);
    assert.equal(valueOf(rows, '标题'), 'MagiesPdf fixture');
    assert.equal(valueOf(rows, '生成器'), 'MagiesPdf tests');
  });

  it('reports encryption and restrictions for a protected file', async () => {
    const locked = asInput(
      encryptPdf(await samplePdf({ pages: 1 }), {
        userPassword: 'pw',
        permissions: ~(4 | 2048 | 16), // deny print + copy
      }),
      'locked.pdf',
    );
    const result = await executeTool(getInfoTool, { files: [locked], params: { password: 'pw' } });
    const rows = rowsOf(result.data);

    assert.notEqual(valueOf(rows, '加密'), '—');
    const restricted = valueOf(rows, '受限操作') ?? '';
    assert.ok(restricted.includes('打印'), restricted);
    assert.ok(restricted.includes('复制'), restricted);
    assert.ok(!restricted.includes('批注'), restricted);
  });

  it('summarises in the report header', async () => {
    const result = await executeTool(getInfoTool, { files: [await doc(2)], params: {} });
    assert.match(result.summary?.zh ?? '', /2 页/);
  });
});

describe('edit.extract-images', () => {
  it('finds both images and dedupes by object', async () => {
    const bytes = await pdfWithImages();
    const opened = openDocument(bytes);
    try {
      assert.equal(findImages(opened).length, 2);
    } finally {
      opened.destroy();
    }
  });

  it('exports JPEG verbatim and Flate as PNG', async () => {
    const result = await executeTool(extractImagesTool, {
      files: [asInput(await pdfWithImages(), 'illustrated.pdf')],
      params: { minSize: 1 },
    });

    assert.equal(result.files.length, 2);
    const jpgs = result.files.filter((f) => f.name.endsWith('.jpg'));
    const pngs = result.files.filter((f) => f.name.endsWith('.png'));
    assert.equal(jpgs.length, 1);
    assert.equal(pngs.length, 1);
    assert.deepEqual([...jpgs[0]!.bytes.slice(0, 3)], [0xff, 0xd8, 0xff]);
    assert.deepEqual([...pngs[0]!.bytes.slice(1, 4)], [0x50, 0x4e, 0x47]);
  });

  it('filters images below the size threshold', async () => {
    await assert.rejects(
      executeTool(extractImagesTool, {
        files: [asInput(await pdfWithImages(), 'illustrated.pdf')],
        params: { minSize: 4000 },
      }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'EMPTY_RESULT');
        return true;
      },
    );
  });

  it('reports a text-only document as having no images', async () => {
    await assert.rejects(
      executeTool(extractImagesTool, { files: [await doc(2)], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'EMPTY_RESULT');
        return true;
      },
    );
  });
});
