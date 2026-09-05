import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { annotateTool } from './annotate.ts';

function annotationTypes(bytes: Uint8Array, pageNumber = 1): string[] {
  const doc = openDocument(bytes);
  try {
    return doc.loadPage(pageNumber - 1).getAnnotations().map((a) => a.getType());
  } finally {
    doc.destroy();
  }
}

const marks = JSON.stringify({
  highlights: [{ pageNumber: 1, rects: [{ x: 72, y: 100, width: 120, height: 14 }], color: '#fef08a' }],
  ink: [{ pageNumber: 1, points: [{ x: 100, y: 200 }, { x: 180, y: 200 }], color: '#ef4444', strokeWidth: 2 }],
});

describe('edit.annotate', () => {
  it('writes the marks and keeps the document name', async () => {
    const source = await samplePdf({ pages: 1 });
    const result = await executeTool(annotateTool, {
      files: [asInput(source, 'report.pdf')],
      params: { annotations: marks },
    });

    assert.equal(result.files[0]?.name, 'report.pdf');
    assert.deepEqual(annotationTypes(result.files[0]!.bytes).sort(), ['Highlight', 'Ink']);
  });

  /**
   * It is reached by id from the viewer, never chosen from the grid — so the
   * data always comes from code. A refusal is therefore a bug being reported,
   * not a user being told off, and it must not half-apply.
   */
  it('refuses data that is not JSON', async () => {
    const source = await samplePdf({ pages: 1 });
    await assert.rejects(
      () => executeTool(annotateTool, {
        files: [asInput(source, 'a.pdf')],
        params: { annotations: 'not json' },
      }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_PARAM',
    );
  });

  it('refuses a request with nothing in it', async () => {
    const source = await samplePdf({ pages: 1 });
    await assert.rejects(
      () => executeTool(annotateTool, {
        files: [asInput(source, 'a.pdf')],
        params: { annotations: '{"highlights":[],"ink":[]}' },
      }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_PARAM',
    );
  });

  it('is not offered in the grid, the palette or a pipeline', () => {
    assert.equal(annotateTool.hidden, true);
    assert.equal(annotateTool.pipelineable, false);
  });
});
