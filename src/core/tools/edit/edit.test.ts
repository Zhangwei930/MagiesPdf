import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { allPageText, asInput, encryptPdf, samplePdf } from '../../testing/fixtures.ts';
import { compressTool } from './compress.ts';
import { addPageNumbersTool, formatPageLabel } from './pageNumbers.ts';
import { addWatermarkTool } from '../security/watermark.ts';

const doc = async (pages: number, extra: Parameters<typeof samplePdf>[0] = {}) =>
  asInput(await samplePdf({ pages, label: (n) => `P${n}`, ...extra }), 'report.pdf');

describe('edit.compress', () => {
  it('produces a valid, no-larger file with the lossless level', async () => {
    const input = await doc(10, { bodyLines: 60 });
    const result = await executeTool(compressTool, {
      files: [input],
      params: { level: 'standard' },
    });

    assert.equal(result.files[0]!.name, 'report_compressed.pdf');
    assert.ok(
      result.files[0]!.bytes.length <= input.bytes.length,
      `grew: ${input.bytes.length} → ${result.files[0]!.bytes.length}`,
    );
    assert.equal(allPageText(result.files[0]!.bytes).length, 10);
  });

  it('keeps every page under aggressive compression', async () => {
    const result = await executeTool(compressTool, {
      files: [await doc(4)],
      params: { level: 'aggressive' },
    });
    assert.equal(allPageText(result.files[0]!.bytes).length, 4);
  });

  it('shrinks a photo-heavy PDF under aggressive compression', async () => {
    // Smooth gradient PNG (Flate) becomes a much smaller JPEG when re-encoded.
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const width = 800;
    const height = 1000;
    const png = await makeGradientPng(width, height);
    const image = await pdf.embedPng(png);
    for (let i = 0; i < 3; i += 1) {
      const page = pdf.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
    }
    const heavy = asInput(await pdf.save({ useObjectStreams: false }), 'photos.pdf');

    const result = await executeTool(compressTool, {
      files: [heavy],
      params: { level: 'aggressive' },
    });
    const after = result.files[0]!.bytes.length;
    assert.ok(
      after < heavy.bytes.length * 0.5,
      `expected aggressive compress to cut >50%: ${heavy.bytes.length} → ${after}`,
    );
  });

  it('compresses an encrypted file into an open one', async () => {
    const locked = asInput(
      encryptPdf(await samplePdf({ pages: 2, label: (n) => `P${n}` }), { userPassword: 'pw' }),
      'locked.pdf',
    );
    const result = await executeTool(compressTool, {
      files: [locked],
      params: { password: 'pw', level: 'standard' },
    });

    const opened = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(opened.needsPassword(), false);
    } finally {
      opened.destroy();
    }
  });
});

/** Smooth RGB gradient PNG — Flate-heavy in PDF, tiny as JPEG. */
async function makeGradientPng(width: number, height: number): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  try {
    const pixels = pixmap.getPixels();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = Math.round((x / width) * 255);
        pixels[offset + 1] = Math.round((y / height) * 255);
        pixels[offset + 2] = 180;
      }
    }
    return pixmap.asPNG();
  } finally {
    pixmap.destroy();
  }
}

describe('formatPageLabel', () => {
  it('substitutes n and total', () => {
    assert.equal(formatPageLabel('{n} / {total}', 3, 9), '3 / 9');
  });

  it('substitutes repeated placeholders', () => {
    assert.equal(formatPageLabel('{n}{n}', 2, 5), '22');
  });

  it('leaves literal text alone', () => {
    assert.equal(formatPageLabel('第 {n} 页，共 {total} 页', 1, 10), '第 1 页，共 10 页');
  });
});

describe('edit.add-page-numbers', () => {
  it('numbers every page and keeps the body', async () => {
    const result = await executeTool(addPageNumbersTool, {
      files: [await doc(3)],
      params: { format: 'ofTotal' },
    });

    const texts = allPageText(result.files[0]!.bytes);
    assert.ok(texts[0]!.includes('P1') && texts[0]!.includes('1 / 3'), texts[0]);
    assert.ok(texts[2]!.includes('3 / 3'), texts[2]);
  });

  it('honours the starting number', async () => {
    const result = await executeTool(addPageNumbersTool, {
      files: [await doc(2)],
      params: { startAt: 10 },
    });
    const texts = allPageText(result.files[0]!.bytes);
    assert.ok(texts[0]!.includes('10'));
    assert.ok(texts[1]!.includes('11'));
  });

  it('numbers only the selected pages, counting only them', async () => {
    const result = await executeTool(addPageNumbersTool, {
      files: [await doc(4)],
      params: { format: 'ofTotal', pages: '3-4' },
    });
    const texts = allPageText(result.files[0]!.bytes);
    assert.ok(!texts[0]!.includes('/'), 'page 1 must stay clean');
    assert.ok(texts[2]!.includes('1 / 2'), texts[2]);
    assert.ok(texts[3]!.includes('2 / 2'), texts[3]);
  });

  it('applies the Chinese preset', async () => {
    const result = await executeTool(addPageNumbersTool, {
      files: [await doc(2)],
      params: { format: 'zh' },
    });
    assert.ok(allPageText(result.files[0]!.bytes)[0]!.includes('第 1 页，共 2 页'));
  });

  it('uses the custom template when chosen', async () => {
    const result = await executeTool(addPageNumbersTool, {
      files: [await doc(1)],
      params: { format: 'custom', template: 'Page {n} of {total}' },
    });
    assert.ok(allPageText(result.files[0]!.bytes)[0]!.includes('Page 1 of 1'));
  });
});

describe('security.add-watermark', () => {
  it('requires non-empty text', async () => {
    await assert.rejects(
      executeTool(addWatermarkTool, { files: [await doc(1)], params: { text: '  ' } }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_PARAM');
        return true;
      },
    );
  });

  it('stamps only the selected pages', async () => {
    const result = await executeTool(addWatermarkTool, {
      files: [await doc(3)],
      params: { text: 'DRAFT', pages: '2' },
    });
    const texts = allPageText(result.files[0]!.bytes);
    assert.ok(!texts[0]!.includes('DRAFT'));
    assert.ok(texts[1]!.includes('DRAFT'));
    assert.ok(!texts[2]!.includes('DRAFT'));
  });

  it('tiles when asked', async () => {
    const result = await executeTool(addWatermarkTool, {
      files: [await doc(1)],
      params: { text: 'WM', tile: true },
    });
    const occurrences = (allPageText(result.files[0]!.bytes)[0] ?? '').split('WM').length - 1;
    assert.ok(occurrences >= 4, `expected a grid, got ${occurrences}`);
  });

  it('watermarks an encrypted source, producing an open output', async () => {
    const locked = asInput(
      encryptPdf(await samplePdf({ pages: 1, label: () => 'BODY' }), { userPassword: 'pw' }),
      'l.pdf',
    );
    const result = await executeTool(addWatermarkTool, {
      files: [locked],
      params: { text: '机密', password: 'pw' },
    });
    const text = allPageText(result.files[0]!.bytes)[0] ?? '';
    assert.ok(text.includes('BODY') && text.includes('机密'));
  });
});
