import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as mupdf from 'mupdf';
import { executeTool } from '../../execute.ts';
import { asInput, pageText, samplePdf } from '../../testing/fixtures.ts';
import { replaceTextTool, parseReplacements } from './replaceText.ts';

describe('parseReplacements', () => {
  it('reads one old=new pair per line', () => {
    const pairs = parseReplacements('Page 1=Cover\nPage 2=Contents');
    assert.deepEqual(pairs, [
      { find: 'Page 1', replace: 'Cover' },
      { find: 'Page 2', replace: 'Contents' },
    ]);
  });

  it('lets the replacement be empty, but never the phrase to find', () => {
    assert.deepEqual(parseReplacements('Draft='), [{ find: 'Draft', replace: '' }]);
    assert.throws(() => parseReplacements('=Cover'), /find|left|=/i);
  });

  it('refuses text it cannot draw rather than writing nothing', () => {
    // pdf-lib's standard fonts cannot encode CJK. Drawing it silently produces
    // an empty box or throws from deep inside the encoder, and the caller is
    // left with a document that lost its text and gained nothing.
    assert.throws(() => parseReplacements('Page 1=封面'), /Latin|WinAnsi|拉丁/i);
  });
});

/**
 * The largest square of solid ink on a page.
 *
 * Text never fills one: a 36pt stroke is a few pixels wide. A censor's black
 * box does, and `applyRedactions` paints one by default — which the text
 * assertions cannot see, because the replacement is still in the file, drawn
 * underneath it.
 */
function largestSolidBlock(bytes: Uint8Array): number {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(0);
  const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true);
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const pixels = pixmap.getPixels();
  let largest = 0;
  for (let y = 0; y + 16 <= height; y += 8) {
    for (let x = 0; x + 16 <= width; x += 8) {
      let dark = 0;
      for (let row = 0; row < 16; row += 1) {
        for (let column = 0; column < 16; column += 1) {
          if (pixels[(y + row) * width + (x + column)]! < 128) dark += 1;
        }
      }
      largest = Math.max(largest, dark);
    }
  }
  pixmap.destroy();
  page.destroy();
  doc.destroy();
  return largest / 256;
}

describe('edit.replace-text', () => {
  it('takes the old words out and puts the new ones in their place', async () => {
    const source = await samplePdf({ pages: 2, label: (n) => `Page ${n}` });
    const result = await executeTool(replaceTextTool, {
      files: [asInput(source)],
      params: { replacements: 'Page 1=Cover', pages: 'all', size: 0, password: '' },
    });

    const first = pageText(result.files[0]!.bytes, 0);
    // Redaction removes the glyphs, so the old text is genuinely gone rather
    // than hidden under a white rectangle that any reader can select through.
    assert.doesNotMatch(first, /Page 1/);
    assert.match(first, /Cover/);
    // And the page it was not asked about is untouched.
    assert.match(pageText(result.files[0]!.bytes, 1), /Page 2/);

    // The text assertions above pass just as well when the replacement is
    // drawn underneath a censor's black box, which is what redaction paints
    // unless told not to. Only looking at the page catches that.
    assert.ok(
      largestSolidBlock(result.files[0]!.bytes) < 0.9,
      'the page has a solid block of ink on it',
    );
  });

  it('deletes the phrase when the replacement is empty', async () => {
    const source = await samplePdf({ pages: 1, label: () => 'Draft copy' });
    const result = await executeTool(replaceTextTool, {
      files: [asInput(source)],
      params: { replacements: 'Draft=', pages: 'all', size: 0, password: '' },
    });
    const text = pageText(result.files[0]!.bytes, 0);
    assert.doesNotMatch(text, /Draft/);
    assert.match(text, /copy/);
  });

  it('says so when the phrase is not there, rather than returning the file unchanged', async () => {
    const source = await samplePdf({ pages: 1 });
    await assert.rejects(
      () => executeTool(replaceTextTool, {
        files: [asInput(source)],
        params: { replacements: 'Nowhere=Somewhere', pages: 'all', size: 0, password: '' },
      }),
      /No matches|EMPTY/i,
    );
  });
});
