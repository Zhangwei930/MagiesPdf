import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mupdf from 'mupdf';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { addStampTool } from './stamp.ts';

/** A solid red square, so its position is unmistakable once rendered. */
async function redSquarePng(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(1, 0, 0) });
  const source = openDocument(await doc.save({ useObjectStreams: false }));
  try {
    return renderPage(source, 0, { dpi: 72, format: 'png' }).bytes;
  } finally {
    source.destroy();
  }
}

/**
 * Renders page 0 at 1pt-per-pixel and reports whether the pixel at a point in
 * *displayed* space is red — the same space the user clicked in.
 */
function isRedAt(pdf: Uint8Array, x: number, y: number): boolean {
  const doc = openDocument(pdf);
  try {
    const page = doc.loadPage(0);
    const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const pixels = pixmap.getPixels();
      const components = pixels.length / (width * height);
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || py < 0 || px >= width || py >= height) return false;
      const at = (py * width + px) * components;
      const [r, g, b] = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
      return r > 200 && g < 80 && b < 80;
    } finally {
      pixmap.destroy();
    }
  } finally {
    doc.destroy();
  }
}

async function stampAt(pdf: Uint8Array, centerX: number, centerY: number): Promise<Uint8Array> {
  const result = await executeTool(addStampTool, {
    files: [asInput(pdf, 'page.pdf'), asInput(await redSquarePng(), 'seal.png', 'image/png')],
    params: { placement: 'point', centerX, centerY, widthPercent: 10, pages: '1' },
  });
  return result.files[0]!.bytes;
}

describe('edit.add-stamp — point placement', () => {
  it('centres the stamp on the clicked point of an upright page', async () => {
    const stamped = await stampAt(await samplePdf({ pages: 1 }), 200, 300);

    assert.ok(isRedAt(stamped, 200, 300), 'clicked point should be inked');
    assert.ok(!isRedAt(stamped, 200, 500), 'far below the click should be clean');
    assert.ok(!isRedAt(stamped, 450, 300), 'far right of the click should be clean');
  });

  it('lands on the clicked point of a page rotated 90°', async () => {
    // Rotate first, so the viewer would be showing an 842x595 landscape page.
    const upright = await samplePdf({ pages: 1 });
    const doc = await PDFDocument.load(upright, { updateMetadata: false });
    doc.getPage(0).setRotation(degrees(90));
    const rotated = await doc.save({ useObjectStreams: false });

    const stamped = await stampAt(rotated, 700, 120);

    assert.ok(isRedAt(stamped, 700, 120), 'clicked point should be inked on a rotated page');
    assert.ok(!isRedAt(stamped, 100, 120), 'the mirrored x should be clean');
  });

  it('keeps the stamp upright on screen when the page is rotated', async () => {
    // A wide bar: if the counter-rotation is wrong it renders tall, not wide.
    const bar = await PDFDocument.create();
    const barPage = bar.addPage([200, 50]);
    barPage.drawRectangle({ x: 0, y: 0, width: 200, height: 50, color: rgb(1, 0, 0) });
    const barSource = openDocument(await bar.save({ useObjectStreams: false }));
    const barPng = renderPage(barSource, 0, { dpi: 72, format: 'png' }).bytes;
    barSource.destroy();

    const upright = await samplePdf({ pages: 1 });
    const doc = await PDFDocument.load(upright, { updateMetadata: false });
    doc.getPage(0).setRotation(degrees(90));
    const rotated = await doc.save({ useObjectStreams: false });

    // Page shows as 842x595; stamp the middle at 20% of the displayed width.
    const result = await executeTool(addStampTool, {
      files: [asInput(rotated, 'page.pdf'), asInput(barPng, 'bar.png', 'image/png')],
      params: { placement: 'point', centerX: 421, centerY: 297, widthPercent: 20, pages: '1' },
    });
    const stamped = result.files[0]!.bytes;

    // 20% of 842 is ~168 wide, a quarter of that tall (~42).
    assert.ok(isRedAt(stamped, 421, 297), 'centre should be inked');
    assert.ok(isRedAt(stamped, 421 + 60, 297), 'should extend sideways on screen');
    assert.ok(!isRedAt(stamped, 421, 297 + 60), 'should not extend that far vertically');
  });

  it('rejects a point outside the page', async () => {
    await assert.rejects(
      stampAt(await samplePdf({ pages: 1 }), 5000, 5000),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });

  it('still honours the corner presets when placement is not a point', async () => {
    const result = await executeTool(addStampTool, {
      files: [
        asInput(await samplePdf({ pages: 1 }), 'page.pdf'),
        asInput(await redSquarePng(), 'seal.png', 'image/png'),
      ],
      params: { position: 'top-left', widthPercent: 10, margin: 20, pages: '1' },
    });

    const stamped = result.files[0]!.bytes;
    assert.ok(isRedAt(stamped, 40, 40), 'top-left corner should be inked');
    assert.ok(!isRedAt(stamped, 550, 800), 'bottom-right should be clean');
  });
});
