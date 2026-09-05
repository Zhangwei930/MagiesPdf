import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, PDFName, type PDFArray, type PDFNumber } from 'pdf-lib';
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
   * The viewer submits one mark per run — the new one — so a run that cleared
   * what it had written before meant every mark deleted the one before it.
   * Undo already covers "take that back": a run is an edit on the document's
   * bytes like any other, so the previous bytes still carry the previous mark.
   */
  it('adds to the marks already there rather than replacing them', async () => {
    const source = await samplePdf({ pages: 1 });
    const once = writeAnnotations(source, { highlights: [highlight()], ink: [] });
    const twice = writeAnnotations(once, { highlights: [], ink: [ink()] });

    assert.deepEqual(
      annotationsOn(twice, 1).map((entry) => entry.type).sort(),
      ['Highlight', 'Ink'],
    );
  });

  it('keeps every stroke of a run of pen marks', async () => {
    const source = await samplePdf({ pages: 1 });
    let written = source;
    for (let n = 0; n < 3; n += 1) {
      written = writeAnnotations(written, { highlights: [], ink: [ink()] });
    }

    assert.equal(annotationsOn(written, 1).length, 3);
  });

  it('opens an encrypted document with its password', async () => {
    const { encryptPdf } = await import('../testing/fixtures.ts');
    const encrypted = encryptPdf(await samplePdf({ pages: 1 }), { userPassword: 'pw' });

    const written = writeAnnotations(encrypted, { highlights: [highlight()], ink: [] }, 'pw');
    assert.equal(annotationsOn(written, 1).length, 1);
  });
});

/**
 * Where the mark lands, checked without MuPDF.
 *
 * The first version of these tests read the geometry back with MuPDF's
 * `getBounds()` and asserted `PAGE_HEIGHT - y`. Both the writer and the
 * reader work in the page's *displayed* space, so the assertion compared a
 * wrong value against itself and passed: a mark drawn 100pt from the top was
 * written 742pt from the top, and every test here was green.
 *
 * So the geometry is read straight out of the PDF with pdf-lib instead. What
 * ends up in the file is in PDF user space — origin bottom-left, y upward —
 * and that is the one description of a mark's position that does not depend
 * on the library that wrote it.
 */
describe('where the mark lands on the page', () => {
  /** The raw `/InkList` of the first annotation, as the file stores it. */
  async function rawInkList(bytes: Uint8Array): Promise<number[]> {
    const doc = await PDFDocument.load(bytes);
    const annotations = doc.getPage(0).node.Annots();
    const annotation = annotations?.lookup(0) as unknown as { lookup(key: unknown): unknown };
    const list = annotation.lookup(PDFName.of('InkList')) as PDFArray;
    return (list.lookup(0) as PDFArray)
      .asArray()
      .map((entry) => (entry as PDFNumber).asNumber());
  }

  /** The raw `/QuadPoints` of the first annotation. */
  async function rawQuadPoints(bytes: Uint8Array): Promise<number[]> {
    const doc = await PDFDocument.load(bytes);
    const annotations = doc.getPage(0).node.Annots();
    const annotation = annotations?.lookup(0) as unknown as { lookup(key: unknown): unknown };
    return (annotation.lookup(PDFName.of('QuadPoints')) as PDFArray)
      .asArray()
      .map((entry) => (entry as PDFNumber).asNumber());
  }

  it('puts a stroke drawn 100pt from the top 100pt from the top', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, {
      highlights: [],
      ink: [ink({ points: [{ x: 100, y: 100 }, { x: 200, y: 100 }] })],
    });

    const [x, y] = await rawInkList(written);
    assert.equal(x, 100, 'x is the same in both spaces');
    // User space measures up from the bottom, so 100 from the top of an
    // 842pt page is 742 — not 100, which would be 742 from the top.
    assert.ok(Math.abs((y ?? 0) - (PAGE_HEIGHT - 100)) < 1, `stroke sat at y=${y}, expected 742`);
  });

  it('puts a highlight where the text it covers is', async () => {
    const source = await samplePdf({ pages: 1 });
    const written = writeAnnotations(source, {
      highlights: [highlight({ rects: [{ x: 72, y: 100, width: 120, height: 14 }] })],
      ink: [],
    });

    const quad = await rawQuadPoints(written);
    const ys = [quad[1], quad[3], quad[5], quad[7]].map((value) => value ?? 0);
    assert.ok(Math.abs(Math.max(...ys) - (PAGE_HEIGHT - 100)) < 1, `top edge at ${Math.max(...ys)}`);
    assert.ok(Math.abs(Math.min(...ys) - (PAGE_HEIGHT - 114)) < 1, `bottom edge at ${Math.min(...ys)}`);
  });

  /**
   * A scanned page often arrives rotated, and it is where a coordinate bug
   * hides: every other case here uses an upright page, so a mark that lands
   * sideways passes all of them. MuPDF rotates as it converts, so the viewer
   * must not — pdf.js's `convertToPdfPoint` would undo it a second time.
   */
  it('follows the page as the reader sees it when the page is rotated', async () => {
    const upright = openDocument(await samplePdf({ pages: 1 }));
    (upright as unknown as { findPage(index: number): { put(key: string, value: number): void } })
      .findPage(0)
      .put('Rotate', 90);
    const rotated = saveDocument(upright);
    upright.destroy();

    const written = writeAnnotations(rotated, {
      highlights: [],
      ink: [ink({ points: [{ x: 50, y: 60 }, { x: 150, y: 60 }] })],
    });

    // Displayed 90° clockwise, an A4 page is 842 × 595 and a displayed point
    // (dx, dy) is user-space (dy, dx).
    const [x, y] = await rawInkList(written);
    assert.equal(x, 60, 'displayed 60pt from the top');
    assert.equal(y, 50, 'displayed 50pt from the left');
  });

  it('does not put it upside down', async () => {
    const source = await samplePdf({ pages: 1 });
    const near = (y: number) =>
      writeAnnotations(source, {
        highlights: [],
        ink: [ink({ points: [{ x: 72, y }, { x: 172, y }] })],
      });

    const [, high] = await rawInkList(near(50));
    const [, low] = await rawInkList(near(780));
    // Drawn nearer the top means a larger user-space y.
    assert.ok((high ?? 0) > (low ?? 0), `drawn higher should sit higher: ${high} vs ${low}`);
  });
});
