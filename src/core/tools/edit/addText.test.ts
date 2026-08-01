import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mupdf from 'mupdf';
import { degrees, PDFDocument } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { addTextTool } from './addText.ts';

async function blankPdf(rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.setRotation(degrees(rotation));
  return doc.save({ useObjectStreams: false });
}

function hasInkIn(pdf: Uint8Array, left: number, top: number, right: number, bottom: number): boolean {
  const doc = openDocument(pdf);
  try {
    const pixmap = doc.loadPage(0).toPixmap(
      mupdf.Matrix.identity,
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    );
    try {
      const width = pixmap.getWidth();
      const pixels = pixmap.getPixels();
      const components = pixmap.getNumberOfComponents();
      for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
        for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
          const offset = (y * width + x) * components;
          if (
            (pixels[offset] as number) < 160 ||
            (pixels[offset + 1] as number) < 160 ||
            (pixels[offset + 2] as number) < 160
          ) return true;
        }
      }
      return false;
    } finally {
      pixmap.destroy();
    }
  } finally {
    doc.destroy();
  }
}

describe('edit.add-text', () => {
  it('adds text to one page at the requested point', async () => {
    const result = await executeTool(addTextTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (page) => (page === 1 ? 'one' : 'two') }), 'source.pdf')],
      params: { text: '现场输入', page: 2, x: 72, y: 500, size: 14, color: '#111111' },
    });

    const pages = allPageText(result.files[0]!.bytes);
    assert.ok(!pages[0]!.includes('现场输入'));
    assert.ok(pages[1]!.includes('现场输入'));
  });

  it('places text at the clicked top-left display coordinate', async () => {
    const result = await executeTool(addTextTool, {
      files: [asInput(await blankPdf(), 'blank.pdf')],
      params: { text: 'hello', page: 1, x: 70, y: 120, size: 14, color: '#111111' },
    });

    assert.ok(hasInkIn(result.files[0]!.bytes, 65, 95, 150, 130));
    assert.ok(!hasInkIn(result.files[0]!.bytes, 65, 690, 150, 740));
  });

  it('keeps directly entered text at the clicked point on a rotated page', async () => {
    const result = await executeTool(addTextTool, {
      files: [asInput(await blankPdf(90), 'rotated.pdf')],
      params: { text: 'hello', page: 1, x: 650, y: 120, size: 14, color: '#111111' },
    });

    assert.ok(hasInkIn(result.files[0]!.bytes, 640, 95, 730, 135));
    assert.ok(!hasInkIn(result.files[0]!.bytes, 90, 620, 140, 700));
  });

  it('rejects blank text and a page outside the document', async () => {
    const file = asInput(await samplePdf({ pages: 1, label: () => 'one' }), 'source.pdf');

    await assert.rejects(
      executeTool(addTextTool, {
        files: [file],
        params: { text: '   ', page: 1, x: 72, y: 500, size: 14, color: '#111111' },
      }),
      (error: unknown) => error instanceof ToolError && error.code === 'INVALID_PARAM',
    );
    await assert.rejects(
      executeTool(addTextTool, {
        files: [file],
        params: { text: 'hello', page: 2, x: 72, y: 500, size: 14, color: '#111111' },
      }),
      /page is outside the document/,
    );
  });
});
