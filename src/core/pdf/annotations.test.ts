import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDocument, saveDocument } from './document.ts';
import { samplePdf } from '../testing/fixtures.ts';
import { writeAnnotations, type InkStroke, type TextHighlight } from './annotations.ts';

/** What a reader would find on the page, without trusting the writer's own view. */
function annotationsOn(
  bytes: Uint8Array,
  pageNumber: number,
): { type: string; rect: number[] }[] {
  const doc = openDocument(bytes);
  try {
    const page = doc.loadPage(pageNumber - 1);
    return page.getAnnotations().map((annotation) => ({
      type: annotation.getType(),
      rect: [...annotation.getBounds()],
    }));
  } finally {
    doc.destroy();
  }
}

/** A4 as `samplePdf` makes it: 595 × 842 points. */
const PAGE_HEIGHT = 842;

const highlight = (over: Partial<TextHighlight> = {}): TextHighlight => ({
  pageNumber: 1,
  // Viewer space: 72pt in from the left, 100pt down from the top.
  rects: [{ x: 72, y: 100, width: 120, height: 14 }],
  color: '#fef08a',
  ...over,
});

const ink = (over: Partial<InkStroke> = {}): InkStroke => ({
  pageNumber: 1,
  points: [{ x: 100, y: 200 }, { x: 140, y: 220 }, { x: 180, y: 200 }],
  color: '#ef4444',
  strokeWidth: 2,
  ...over,
});

describe('writing annotations into a PDF', () => {
  it('returns the document unchanged when there is nothing to write', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, { highlights: [], ink: [] });
    assert.equal(written, source, 'no save, no re-encode, no new bytes');
  });

  /**
   * The point of the whole feature: the mark has to survive being closed and
   * reopened, as an annotation another reader can see — not as pixels burned
   * into the page.
   */
  it('writes a highlight another reader finds as a Highlight annotation', async () => {
    const source = await samplePdf({ pages: 2 });
    const written = writeAnnotations(source, { highlights: [highlight()], ink: [] });

    const found = annotationsOn(written, 1);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.type, 'Highlight');
    assert.deepEqual(annotationsOn(written, 2), [], 'only the page it was drawn on');
  });

  it('writes ink as an Ink annotation', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, { highlights: [], ink: [ink()] });

    const found = annotationsOn(written, 1);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.type, 'Ink');
  });

  it('writes both kinds at once, on the pages they belong to', async () => {
    const source = await samplePdf({ pages: 3 });
    const written = writeAnnotations(source, {
      highlights: [highlight({ pageNumber: 1 }), highlight({ pageNumber: 3 })],
      ink: [ink({ pageNumber: 3 })],
    });

    assert.equal(annotationsOn(written, 1).length, 1);
    assert.equal(annotationsOn(written, 2).length, 0);
    assert.equal(annotationsOn(written, 3).length, 2);
  });

  /** A highlight covers several lines; each line is its own quad. */
  it('keeps every rectangle of a highlight that spans lines', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, {
      highlights: [highlight({
        rects: [
          { x: 72, y: 700, width: 400, height: 14 },
          { x: 72, y: 684, width: 260, height: 14 },
        ],
      })],
      ink: [],
    });

    assert.equal(annotationsOn(written, 1).length, 1, 'one annotation, not one per line');
  });

  it('ignores a mark on a page the document does not have', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, {
      highlights: [highlight({ pageNumber: 9 })],
      ink: [ink({ pageNumber: 0 })],
    });

    assert.equal(annotationsOn(written, 1).length, 0);
  });

  it('ignores a stroke with nothing to draw', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, {
      highlights: [highlight({ rects: [] })],
      ink: [ink({ points: [] })],
    });

    assert.equal(annotationsOn(written, 1).length, 0);
  });

  /**
   * Writing twice must not stack: the document carries its marks, so a second
   * save of the same set is the same document, not a document with everything
   * duplicated.
   */
  it('replaces the marks it wrote rather than adding to them', async () => {
    const source = await samplePdf({ pages: 1 });
    const once = writeAnnotations(source, { highlights: [highlight()], ink: [] });
    const twice = writeAnnotations(once, { highlights: [highlight()], ink: [] });

    assert.equal(annotationsOn(twice, 1).length, 1);
  });

  it('opens an encrypted document with its password', async () => {
    const { encryptPdf } = await import('../testing/fixtures.ts');
    const encrypted = encryptPdf(await samplePdf({ pages: 1 }), { userPassword: 'pw' });

    const written = writeAnnotations(encrypted, { highlights: [highlight()], ink: [] }, 'pw');
    assert.equal(annotationsOn(written, 1).length, 1);
  });
});

/**
 * The flip is the part a reader cannot check by eye: a mark drawn near the top
 * of the page must land near the top of the page, and getting it upside down
 * would look plausible in every other assertion here.
 */
describe('where the mark lands on the page', () => {
  it('puts a mark drawn near the top near the top', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, {
      highlights: [highlight({ rects: [{ x: 72, y: 100, width: 120, height: 14 }] })],
      ink: [],
    });

    const [found] = annotationsOn(written, 1);
    const [, bottom, , top] = found?.rect ?? [];
    // 100pt down from the top of an 842pt page is 742pt up from the bottom.
    // The reported bounds sit a few points outside the quad — a highlight's
    // box is inflated by its own border — so this checks the position, not the
    // exact edge. The direction is what the next test pins down.
    assert.ok(Math.abs((top ?? 0) - (PAGE_HEIGHT - 100)) < 6, `top was ${top}`);
    assert.ok(Math.abs((bottom ?? 0) - (PAGE_HEIGHT - 114)) < 6, `bottom was ${bottom}`);
  });

  it('does not put it upside down', async () => {
    const source = await samplePdf({ pages: 1 });
    const nearTop = writeAnnotations(source, {
      highlights: [highlight({ rects: [{ x: 72, y: 50, width: 100, height: 10 }] })],
      ink: [],
    });
    const nearBottom = writeAnnotations(source, {
      highlights: [highlight({ rects: [{ x: 72, y: 780, width: 100, height: 10 }] })],
      ink: [],
    });

    const topY = annotationsOn(nearTop, 1)[0]?.rect[3] ?? 0;
    const bottomY = annotationsOn(nearBottom, 1)[0]?.rect[3] ?? 0;
    assert.ok(topY > bottomY, `drawn higher should sit higher: ${topY} vs ${bottomY}`);
  });

  it('keeps ink where it was drawn', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, {
      highlights: [],
      ink: [ink({ points: [{ x: 100, y: 200 }, { x: 300, y: 200 }] })],
    });

    const [, bottom, , top] = annotationsOn(written, 1)[0]?.rect ?? [];
    const middle = ((bottom ?? 0) + (top ?? 0)) / 2;
    assert.ok(Math.abs(middle - (PAGE_HEIGHT - 200)) < 6, `stroke sat at ${middle}`);
  });
});

/**
 * A scanned page often arrives rotated, and this is where a coordinate bug
 * would hide: everything else in this file uses an upright page, so a mark
 * that lands sideways would pass every other assertion.
 *
 * Both MuPDF's page bounds and its annotation geometry are in the space the
 * page is *displayed* in, which is the same space the viewer draws in. So the
 * flip is all that is needed, and the renderer must not convert as well —
 * pdf.js's `convertToPdfPoint` would undo the rotation a second time.
 */
describe('a page that is rotated', () => {
  async function rotatedNinety(): Promise<Uint8Array> {
    const doc = openDocument(await samplePdf({ pages: 1 }));
    try {
      const page = doc.loadPage(0) as unknown as { getBounds(): number[] };
      void page.getBounds();
      const pageObject = (doc as unknown as { findPage(index: number): { put(key: string, value: number): void } })
        .findPage(0);
      pageObject.put('Rotate', 90);
      return saveDocument(doc);
    } finally {
      doc.destroy();
    }
  }

  it('measures from the top of the page as the reader sees it', async () => {
    const rotated = await rotatedNinety();

    const doc = openDocument(rotated);
    const [, , , displayedTop] = doc.loadPage(0).getBounds();
    doc.destroy();
    // Rotating swaps the box: an A4 page becomes 842 wide and 595 tall.
    assert.ok(Math.abs((displayedTop ?? 0) - 595) < 1, `displayed height ${displayedTop}`);

    const written = writeAnnotations(rotated, {
      highlights: [highlight({ rects: [{ x: 50, y: 60, width: 100, height: 12 }] })],
      ink: [],
    });

    const top = annotationsOn(written, 1)[0]?.rect[3] ?? 0;
    assert.ok(
      Math.abs(top - ((displayedTop ?? 0) - 60)) < 6,
      `60pt down from the top of the rotated page should be ${(displayedTop ?? 0) - 60}, was ${top}`,
    );
  });
});
