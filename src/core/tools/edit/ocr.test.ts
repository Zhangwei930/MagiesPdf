import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { imageToPdfTool } from '../convert/imageToPdf.ts';
import { ocrTool } from './ocr.ts';

/**
 * OCR end-to-end. The first run downloads the English model (~5 MB, cached in
 * ~/.magiespdf/tessdata); when that download is impossible the tests skip
 * rather than fail, since offline correctness is exactly what the cache is for.
 */

/** A "scan": a text PDF rasterised to PNG and wrapped back into a PDF, no text layer. */
async function scannedPdf(): Promise<Uint8Array> {
  const source = openDocument(await samplePdf({ pages: 1, label: () => 'MAGIES OCR TEST' }));
  let png: Uint8Array;
  try {
    png = renderPage(source, 0, { dpi: 150, format: 'png' }).bytes;
  } finally {
    source.destroy();
  }

  const wrapped = await executeTool(imageToPdfTool, {
    files: [asInput(png, 'scan.png', 'image/png')],
    params: { pageSize: 'fit' },
  });
  return wrapped.files[0]!.bytes;
}

function isOfflineFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    /Failed to initialise OCR|network|fetch/i.test(String((error as Error).message))
  );
}

describe('edit.ocr', () => {
  it('produces a searchable PDF whose text layer contains the printed words', { timeout: 120000 }, async (t) => {
    const scan = asInput(await scannedPdf(), 'scan.pdf');

    // The scan has no text layer at all — the baseline for the assertion below.
    assert.equal(allPageText(scan.bytes)[0] ?? '', '');

    let result;
    try {
      result = await executeTool(ocrTool, {
        files: [scan],
        params: { languages: ['eng'], output: 'searchable', dpi: 300 },
      });
    } catch (error) {
      if (isOfflineFailure(error)) return t.skip('OCR model not cached and no network');
      throw error;
    }

    assert.equal(result.files[0]!.name, 'scan_ocr.pdf');
    const text = allPageText(result.files[0]!.bytes)[0] ?? '';
    assert.ok(/MAGIES/i.test(text), `text layer missing recognised words: "${text}"`);
    assert.ok(/OCR/i.test(text), `text layer missing recognised words: "${text}"`);
  });

  it('exports plain text when asked', { timeout: 120000 }, async (t) => {
    const scan = asInput(await scannedPdf(), 'scan.pdf');

    let result;
    try {
      result = await executeTool(ocrTool, {
        files: [scan],
        params: { languages: ['eng'], output: 'text' },
      });
    } catch (error) {
      if (isOfflineFailure(error)) return t.skip('OCR model not cached and no network');
      throw error;
    }

    assert.equal(result.files[0]!.name, 'scan.txt');
    const text = new TextDecoder().decode(result.files[0]!.bytes);
    assert.ok(/MAGIES/i.test(text), `recognised text was: "${text}"`);
  });

  it('rejects an empty language selection before doing any work', async () => {
    await assert.rejects(
      executeTool(ocrTool, {
        files: [asInput(await samplePdf({ pages: 1 }), 'x.pdf')],
        params: { languages: [] },
      }),
      (e: unknown) => {
        assert.match(String((e as Error).message), /minSelected|at least|至少/i);
        return true;
      },
    );
  });
});
