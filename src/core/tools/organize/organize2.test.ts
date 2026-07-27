import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { analyzePageInk } from '../../pdf/render.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { cropTool } from './crop.ts';
import { N_UP_LAYOUTS, nUpTool } from './nUp.ts';
import { overlayPdfTool } from './overlayPdf.ts';
import { BLANK_THRESHOLDS, removeBlankTool } from './removeBlank.ts';
import { scalePagesTool } from './scalePages.ts';
import { singlePageTool } from './singlePage.ts';
import { chaptersFromOutline, splitByChaptersTool } from './splitByChapters.ts';

const doc = async (pages: number, name = 'report.pdf') =>
  asInput(await samplePdf({ pages, label: (n) => `P${n}` }), name);

function boundsOf(bytes: Uint8Array, pageIndex = 0): [number, number, number, number] {
  const opened = openDocument(bytes);
  try {
    return opened.loadPage(pageIndex).getBounds();
  } finally {
    opened.destroy();
  }
}

function pageCountOf(bytes: Uint8Array): number {
  const opened = openDocument(bytes);
  try {
    return opened.countPages();
  } finally {
    opened.destroy();
  }
}

/** Adds top-level bookmarks at the given 0-based pages. */
async function outlinedPdf(pages: number, anchors: Array<[string, number]>): Promise<Uint8Array> {
  const opened = openDocument(await samplePdf({ pages, label: (n) => `P${n}` }));
  try {
    const iterator = opened.outlineIterator();
    for (const [title, page] of anchors) {
      // The runtime accepts partial items/destinations; the typings demand every field.
      const uri = opened.formatLinkURI({
        page,
        type: 'Fit',
        chapter: 0,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        zoom: 0,
      });
      iterator.insert({ title, uri, open: false });
      iterator.next();
    }
    return saveDocument(opened);
  } finally {
    opened.destroy();
  }
}

describe('analyzePageInk', () => {
  it('reports zero ink on a blank page and a bbox on a printed one', async () => {
    const bytes = await samplePdf({ pages: 2, label: (n) => (n === 1 ? '' : 'CONTENT') });
    const opened = openDocument(bytes);
    try {
      const blank = analyzePageInk(opened, 0);
      assert.equal(blank.inkRatio, 0);
      assert.equal(blank.bbox, null);

      const printed = analyzePageInk(opened, 1);
      assert.ok(printed.inkRatio > 0);
      assert.ok(printed.bbox, 'expected a bounding box');
      // The label is drawn near the top-left; the bbox must sit in that region.
      assert.ok(printed.bbox.x0 >= 40 && printed.bbox.x0 <= 80, `x0=${printed.bbox.x0}`);
      assert.ok(printed.bbox.y1 >= 700, `y1=${printed.bbox.y1}`);
    } finally {
      opened.destroy();
    }
  });
});

describe('organize.scale-pages', () => {
  it('scales to A4 landscape', async () => {
    const result = await executeTool(scalePagesTool, {
      files: [await doc(2)],
      params: { mode: 'paper', paper: 'a4', landscape: true },
    });
    const [, , w, h] = boundsOf(result.files[0]!.bytes);
    assert.equal(Math.round(w), 842);
    assert.equal(Math.round(h), 595);
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P2']);
  });

  it('scales to A5 and keeps content', async () => {
    const result = await executeTool(scalePagesTool, {
      files: [await doc(1)],
      params: { mode: 'paper', paper: 'a5' },
    });
    const [, , w, h] = boundsOf(result.files[0]!.bytes);
    assert.equal(Math.round(w), 420);
    assert.equal(Math.round(h), 595);
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1']);
  });

  it('scales by percentage', async () => {
    const result = await executeTool(scalePagesTool, {
      files: [await doc(1)],
      params: { mode: 'percent', percent: 50 },
    });
    const [, , w, h] = boundsOf(result.files[0]!.bytes);
    assert.equal(Math.round(w), 298);
    assert.equal(Math.round(h), 421);
  });
});

describe('organize.n-up', () => {
  it('declares consistent grids', () => {
    for (const [n, layout] of Object.entries(N_UP_LAYOUTS)) {
      assert.equal(layout.cols * layout.rows, Number(n), `layout ${n}`);
    }
  });

  it('2-up halves the sheet count and turns the sheet sideways', async () => {
    const result = await executeTool(nUpTool, { files: [await doc(4)], params: { n: '2' } });
    assert.equal(pageCountOf(result.files[0]!.bytes), 2);
    const [, , w, h] = boundsOf(result.files[0]!.bytes);
    assert.ok(w > h, `expected landscape, got ${w}×${h}`);
  });

  it('4-up rounds a short document up to one sheet', async () => {
    const result = await executeTool(nUpTool, { files: [await doc(3)], params: { n: '4' } });
    assert.equal(pageCountOf(result.files[0]!.bytes), 1);
  });

  it('16-up packs 20 pages into 2 sheets and keeps text reachable', async () => {
    const result = await executeTool(nUpTool, { files: [await doc(20)], params: { n: '16' } });
    assert.equal(pageCountOf(result.files[0]!.bytes), 2);
    const texts = allPageText(result.files[0]!.bytes);
    assert.ok(texts[0]!.includes('P1') && texts[0]!.includes('P16'), texts[0]);
    assert.ok(texts[1]!.includes('P17') && texts[1]!.includes('P20'), texts[1]);
  });
});

describe('organize.crop', () => {
  it('auto-trim shrinks the crop box around the content', async () => {
    const result = await executeTool(cropTool, {
      files: [await doc(1)],
      params: { mode: 'auto', padding: 10 },
    });

    const opened = openDocument(result.files[0]!.bytes);
    try {
      const cropBox = opened.loadPage(0).getObject().get('CropBox');
      assert.ok(cropBox && !cropBox.isNull(), 'CropBox missing');
      // Label sits top-left, so the cropped area must be far smaller than A4.
      const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => Number(String(cropBox.get(i)))) as [
        number, number, number, number,
      ];
      assert.ok(x1 - x0 < 400, `width ${x1 - x0}`);
      assert.ok(y1 - y0 < 200, `height ${y1 - y0}`);
    } finally {
      opened.destroy();
    }
  });

  it('fixed margins produce the expected crop box', async () => {
    const result = await executeTool(cropTool, {
      files: [await doc(1)],
      params: { mode: 'margins', top: 50, bottom: 40, left: 30, right: 20 },
    });

    const opened = openDocument(result.files[0]!.bytes);
    try {
      // getBounds reflects the crop box.
      const [x0, y0, x1, y1] = opened.loadPage(0).getBounds();
      assert.equal(Math.round(x1 - x0), 595 - 30 - 20);
      assert.equal(Math.round(y1 - y0), 842 - 50 - 40);
    } finally {
      opened.destroy();
    }
  });

  it('rejects margins that consume the page', async () => {
    await assert.rejects(
      executeTool(cropTool, {
        files: [await doc(1)],
        params: { mode: 'margins', left: 300, right: 300 },
      }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_PARAM');
        return true;
      },
    );
  });
});

describe('organize.remove-blank-pages', () => {
  const mixed = async () =>
    asInput(
      await samplePdf({ pages: 5, label: (n) => (n === 2 || n === 4 ? '' : `P${n}`) }),
      'mixed.pdf',
    );

  it('orders thresholds strictly', () => {
    assert.ok(BLANK_THRESHOLDS.strict! < BLANK_THRESHOLDS.normal!);
    assert.ok(BLANK_THRESHOLDS.normal! < BLANK_THRESHOLDS.aggressive!);
  });

  it('removes exactly the blank pages', async () => {
    const result = await executeTool(removeBlankTool, { files: [await mixed()], params: {} });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P3', 'P5']);
    assert.match(result.summary?.zh ?? '', /2, 4/);
  });

  it('aggressive drops a near-blank page that normal keeps', async () => {
    // Page 2 has only a tiny label — a page number, in effect.
    const nearBlank = async () =>
      asInput(
        await samplePdf({
          pages: 3,
          label: (n) => (n === 2 ? '7' : `P${n}`),
          bodyLines: 0,
        }),
        'near.pdf',
      );

    // Normal keeps all three (nothing is fully blank → EMPTY_RESULT).
    await assert.rejects(
      executeTool(removeBlankTool, { files: [await nearBlank()], params: { sensitivity: 'normal' } }),
      (e: unknown) => (e as ToolError).code === 'EMPTY_RESULT',
    );

    const result = await executeTool(removeBlankTool, {
      files: [await nearBlank()],
      params: { sensitivity: 'aggressive' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P3']);
  });

  it('reports when there is nothing to remove', async () => {
    await assert.rejects(
      executeTool(removeBlankTool, { files: [await doc(2)], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'EMPTY_RESULT');
        return true;
      },
    );
  });

  it('refuses to empty an all-blank document', async () => {
    const blank = asInput(await samplePdf({ pages: 2, label: () => '' }), 'blank.pdf');
    await assert.rejects(
      executeTool(removeBlankTool, { files: [blank], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'EMPTY_RESULT');
        return true;
      },
    );
  });
});

describe('chaptersFromOutline', () => {
  it('builds inclusive ranges up to the next chapter', () => {
    assert.deepEqual(
      chaptersFromOutline(
        [
          { title: 'One', page: 0 },
          { title: 'Two', page: 3 },
        ],
        6,
      ),
      [
        { title: 'One', from: 1, to: 3 },
        { title: 'Two', from: 4, to: 6 },
      ],
    );
  });

  it('captures front matter before the first chapter', () => {
    const chapters = chaptersFromOutline([{ title: 'One', page: 2 }], 5);
    assert.deepEqual(chapters, [
      { title: 'Front matter', from: 1, to: 2 },
      { title: 'One', from: 3, to: 5 },
    ]);
  });

  it('returns nothing for a missing outline', () => {
    assert.deepEqual(chaptersFromOutline(null, 5), []);
    assert.deepEqual(chaptersFromOutline([], 5), []);
  });

  it('sorts out-of-order anchors', () => {
    const chapters = chaptersFromOutline(
      [
        { title: 'B', page: 3 },
        { title: 'A', page: 0 },
      ],
      6,
    );
    assert.deepEqual(chapters.map((c) => c.title), ['A', 'B']);
  });
});

describe('organize.split-by-chapters', () => {
  it('splits along bookmarks and names files after them', async () => {
    const bytes = await outlinedPdf(6, [
      ['Introduction', 0],
      ['Deep Dive', 2],
    ]);

    const result = await executeTool(splitByChaptersTool, {
      files: [asInput(bytes, 'book.pdf')],
      params: {},
    });

    assert.equal(result.files.length, 2);
    assert.equal(result.files[0]!.name, 'book_1_Introduction.pdf');
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P2']);
    assert.deepEqual(allPageText(result.files[1]!.bytes), ['P3', 'P4', 'P5', 'P6']);
  });

  it('rejects a document with no outline', async () => {
    await assert.rejects(
      executeTool(splitByChaptersTool, { files: [await doc(3)], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_INPUT');
        return true;
      },
    );
  });
});

describe('organize.single-page', () => {
  it('stitches pages into one tall page', async () => {
    const result = await executeTool(singlePageTool, { files: [await doc(3)], params: {} });

    assert.equal(pageCountOf(result.files[0]!.bytes), 1);
    const [, , w, h] = boundsOf(result.files[0]!.bytes);
    assert.equal(Math.round(w), 595);
    assert.equal(Math.round(h), 842 * 3);

    const text = allPageText(result.files[0]!.bytes)[0] ?? '';
    for (const label of ['P1', 'P2', 'P3']) assert.ok(text.includes(label), `missing ${label}`);
  });

  it('adds the requested gaps', async () => {
    const result = await executeTool(singlePageTool, {
      files: [await doc(2)],
      params: { gap: 20 },
    });
    const [, , , h] = boundsOf(result.files[0]!.bytes);
    assert.equal(Math.round(h), 842 * 2 + 20);
  });
});

describe('organize.overlay', () => {
  const stamp = async () =>
    asInput(await samplePdf({ pages: 2, label: (n) => `STAMP${n}` }), 'letterhead.pdf');

  it('repeats the first overlay page over every base page', async () => {
    const result = await executeTool(overlayPdfTool, {
      files: [await doc(3), await stamp()],
      params: {},
    });

    const texts = allPageText(result.files[0]!.bytes);
    assert.equal(texts.length, 3);
    for (const [index, text] of texts.entries()) {
      assert.ok(text.includes(`P${index + 1}`), `base content lost on page ${index + 1}`);
      assert.ok(text.includes('STAMP1'), `overlay missing on page ${index + 1}`);
    }
  });

  it('cycles overlay pages when asked', async () => {
    const result = await executeTool(overlayPdfTool, {
      files: [await doc(3), await stamp()],
      params: { sequence: 'cycle' },
    });

    const texts = allPageText(result.files[0]!.bytes);
    assert.ok(texts[0]!.includes('STAMP1'));
    assert.ok(texts[1]!.includes('STAMP2'));
    assert.ok(texts[2]!.includes('STAMP1'), 'cycle should wrap around');
  });

  it('limits the overlay to the selected pages', async () => {
    const result = await executeTool(overlayPdfTool, {
      files: [await doc(3), await stamp()],
      params: { pages: '2' },
    });

    const texts = allPageText(result.files[0]!.bytes);
    assert.ok(!texts[0]!.includes('STAMP1'));
    assert.ok(texts[1]!.includes('STAMP1'));
    assert.ok(!texts[2]!.includes('STAMP1'));
  });
});
