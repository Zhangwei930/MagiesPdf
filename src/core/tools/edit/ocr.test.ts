import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { imageToPdfTool } from '../convert/imageToPdf.ts';
import { LANGUAGE_CACHE, assertOcrModelConsent, ocrTool } from './ocr.ts';

/**
 * OCR end-to-end. The first run downloads the English model (~5 MB, cached in
 * ~/.magiespdf/tessdata); when that download is impossible the tests skip
 * rather than fail, since offline correctness is exactly what the cache is for.
 *
 * Skipping used to cover only one of the two ways a download can fail. Offline,
 * it fails at once and is caught. On a slow or filtered link it neither fails
 * nor finishes, so the test sat there until the 120s timeout and went red — on
 * 2026-09-04 that turned a 50-second suite into 3278 seconds and reported a
 * failure that said nothing about this code. A run that has to fetch the model
 * now gets its own, much shorter deadline, and misses it as a skip.
 */

/** Whether every language is already on disk, so the run needs no network. */
function modelsCached(languages: string[]): boolean {
  return languages.every((language) => (
    fs.existsSync(path.join(LANGUAGE_CACHE, `${language}.traineddata`))
  ));
}

/**
 * How long a run that must first download the model may take before it is
 * treated as unreachable. Generous next to a working download of a few MB, and
 * far below the test timeout, which is sized for recognition rather than for
 * the network.
 */
const DOWNLOAD_DEADLINE_MS = 30_000;

/**
 * Runs `work`, giving up early when the model still has to be fetched.
 *
 * Resolves to `null` when it gave up, which the caller turns into a skip. A
 * cached run is not raced at all: recognition legitimately takes a while, and
 * putting a deadline on it would make this flaky in the other direction.
 *
 * The deadline ends the *test*, not the download — cancelling that would mean
 * threading a signal through `executeTool` for a test's benefit. So on a slow
 * link the suite still waits for the fetch to give up on its own before the
 * process exits: measured at 212s where it used to be 3278s and red. Both
 * tests skip; nothing is reported as broken.
 */
async function withDownloadDeadline<T>(
  languages: string[],
  work: () => Promise<T>,
): Promise<T | null> {
  if (modelsCached(languages)) return work();

  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DOWNLOAD_DEADLINE_MS);
  });
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

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
  it('requires explicit consent before a missing language model can use the network', () => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'magiespdf-ocr-consent-'));
    try {
      assert.throws(
        () => assertOcrModelConsent(['eng'], false, cache),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'NETWORK_CONSENT_REQUIRED');
          return true;
        },
      );
      fs.writeFileSync(path.join(cache, 'eng.traineddata'), 'cached');
      assert.doesNotThrow(() => assertOcrModelConsent(['eng'], false, cache));
    } finally {
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  it('produces a searchable PDF whose text layer contains the printed words', { timeout: 120000 }, async (t) => {
    const scan = asInput(await scannedPdf(), 'scan.pdf');

    // The scan has no text layer at all — the baseline for the assertion below.
    assert.equal(allPageText(scan.bytes)[0] ?? '', '');

    let result;
    try {
      result = await withDownloadDeadline(['eng'], () => executeTool(ocrTool, {
        files: [scan],
        params: {
          languages: ['eng'],
          output: 'searchable',
          dpi: 300,
          allowModelDownload: true,
        },
      }));
    } catch (error) {
      if (isOfflineFailure(error)) return t.skip('OCR model not cached and no network');
      throw error;
    }
    if (!result) return t.skip('OCR model not cached and the download did not arrive in time');

    assert.equal(result.files[0]!.name, 'scan_ocr.pdf');
    const text = allPageText(result.files[0]!.bytes)[0] ?? '';
    assert.ok(/MAGIES/i.test(text), `text layer missing recognised words: "${text}"`);
    assert.ok(/OCR/i.test(text), `text layer missing recognised words: "${text}"`);
  });

  it('exports plain text when asked', { timeout: 120000 }, async (t) => {
    const scan = asInput(await scannedPdf(), 'scan.pdf');

    let result;
    try {
      result = await withDownloadDeadline(['eng'], () => executeTool(ocrTool, {
        files: [scan],
        params: { languages: ['eng'], output: 'text', allowModelDownload: true },
      }));
    } catch (error) {
      if (isOfflineFailure(error)) return t.skip('OCR model not cached and no network');
      throw error;
    }
    if (!result) return t.skip('OCR model not cached and the download did not arrive in time');

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
