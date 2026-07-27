import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { allPageText, asInput, encryptPdf, samplePdf } from '../../testing/fixtures.ts';
import { extractPagesTool } from './extractPages.ts';
import { removePagesTool } from './removePages.ts';
import { reorderTool } from './reorder.ts';
import { rotateTool } from './rotate.ts';

const doc = async (pages: number, name = 'report.pdf') =>
  asInput(await samplePdf({ pages, label: (n) => `P${n}` }), name);

/** Reads the /Rotate entry of each page. */
function rotations(bytes: Uint8Array): number[] {
  const opened = openDocument(bytes);
  try {
    return Array.from({ length: opened.countPages() }, (_, i) =>
      Number(opened.loadPage(i).getObject().get('Rotate') ?? 0),
    );
  } finally {
    opened.destroy();
  }
}

describe('organize.extract-pages', () => {
  it('extracts a span', async () => {
    const result = await executeTool(extractPagesTool, {
      files: [await doc(5)],
      params: { pages: '2-4' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P2', 'P3', 'P4']);
  });

  it('extracts in the order written, not sorted order', async () => {
    const result = await executeTool(extractPagesTool, {
      files: [await doc(5)],
      params: { pages: '4,1,3' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P4', 'P1', 'P3']);
  });

  it('allows repeating a page', async () => {
    const result = await executeTool(extractPagesTool, {
      files: [await doc(3)],
      params: { pages: '2,2,2' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P2', 'P2', 'P2']);
  });

  it('honours the odd keyword', async () => {
    const result = await executeTool(extractPagesTool, {
      files: [await doc(6)],
      params: { pages: 'odd' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P3', 'P5']);
  });

  it('writes one file per page when asked', async () => {
    const result = await executeTool(extractPagesTool, {
      files: [await doc(4)],
      params: { pages: '2-3', separate: true },
    });

    assert.deepEqual(result.files.map((f) => f.name), ['report_p2.pdf', 'report_p3.pdf']);
    assert.deepEqual(allPageText(result.files[1]!.bytes), ['P3']);
  });

  it('rejects a page past the end', async () => {
    await assert.rejects(
      executeTool(extractPagesTool, { files: [await doc(3)], params: { pages: '7' } }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'PAGE_OUT_OF_RANGE');
        return true;
      },
    );
  });

  it('works on an encrypted source and outputs it unencrypted', async () => {
    const locked = asInput(
      encryptPdf(await samplePdf({ pages: 3, label: (n) => `P${n}` }), { userPassword: 'pw' }),
      'locked.pdf',
    );
    const result = await executeTool(extractPagesTool, {
      files: [locked],
      params: { pages: '2', password: 'pw' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P2']);
  });
});

describe('organize.remove-pages', () => {
  it('drops the named pages and keeps the rest in order', async () => {
    const result = await executeTool(removePagesTool, {
      files: [await doc(5)],
      params: { pages: '2,4' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P3', 'P5']);
  });

  it('drops even pages', async () => {
    const result = await executeTool(removePagesTool, {
      files: [await doc(6)],
      params: { pages: 'even' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P3', 'P5']);
  });

  it('refuses to empty the document', async () => {
    await assert.rejects(
      executeTool(removePagesTool, { files: [await doc(3)], params: { pages: 'all' } }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'EMPTY_RESULT');
        return true;
      },
    );
  });

  it('tolerates a page named twice', async () => {
    const result = await executeTool(removePagesTool, {
      files: [await doc(4)],
      params: { pages: '2,2' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P3', 'P4']);
  });
});

describe('organize.rotate', () => {
  it('rotates every page by default', async () => {
    const result = await executeTool(rotateTool, { files: [await doc(3)], params: {} });
    assert.deepEqual(rotations(result.files[0]!.bytes), [90, 90, 90]);
  });

  it('rotates only the selected pages', async () => {
    const result = await executeTool(rotateTool, {
      files: [await doc(3)],
      params: { pages: '2', degrees: '180' },
    });
    assert.deepEqual(rotations(result.files[0]!.bytes), [0, 180, 0]);
  });

  it('accumulates on top of an existing rotation', async () => {
    const once = await executeTool(rotateTool, {
      files: [await doc(1)],
      params: { degrees: '90' },
    });
    const twice = await executeTool(rotateTool, {
      files: [asInput(once.files[0]!.bytes, 'r.pdf')],
      params: { degrees: '90', mode: 'add' },
    });
    assert.deepEqual(rotations(twice.files[0]!.bytes), [180]);
  });

  it('replaces the rotation in "set" mode', async () => {
    const once = await executeTool(rotateTool, {
      files: [await doc(1)],
      params: { degrees: '180' },
    });
    const reset = await executeTool(rotateTool, {
      files: [asInput(once.files[0]!.bytes, 'r.pdf')],
      params: { degrees: '90', mode: 'set' },
    });
    assert.deepEqual(rotations(reset.files[0]!.bytes), [90]);
  });

  it('normalises a full turn back to zero', async () => {
    let bytes = (await executeTool(rotateTool, { files: [await doc(1)], params: { degrees: '180' } }))
      .files[0]!.bytes;
    bytes = (
      await executeTool(rotateTool, {
        files: [asInput(bytes, 'r.pdf')],
        params: { degrees: '180', mode: 'add' },
      })
    ).files[0]!.bytes;
    assert.deepEqual(rotations(bytes), [0]);
  });

  it('keeps the page content intact', async () => {
    const result = await executeTool(rotateTool, { files: [await doc(2)], params: {} });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P2']);
  });
});

describe('organize.reorder', () => {
  it('applies a custom order', async () => {
    const result = await executeTool(reorderTool, {
      files: [await doc(4)],
      params: { preset: 'custom', order: '4,3,2,1' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P4', 'P3', 'P2', 'P1']);
  });

  it('drops pages left out of a custom order', async () => {
    const result = await executeTool(reorderTool, {
      files: [await doc(4)],
      params: { preset: 'custom', order: '3,1' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P3', 'P1']);
  });

  it('reverses with the preset', async () => {
    const result = await executeTool(reorderTool, {
      files: [await doc(3)],
      params: { preset: 'reverse' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P3', 'P2', 'P1']);
  });

  it('repairs a fronts-then-backs scan', async () => {
    const result = await executeTool(reorderTool, {
      files: [await doc(6)],
      params: { preset: 'oddEvenMerge' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P4', 'P2', 'P5', 'P3', 'P6']);
  });

  it('produces booklet order', async () => {
    const result = await executeTool(reorderTool, {
      files: [await doc(8)],
      params: { preset: 'booklet' },
    });
    assert.deepEqual(
      allPageText(result.files[0]!.bytes),
      ['P8', 'P1', 'P2', 'P7', 'P6', 'P3', 'P4', 'P5'],
    );
  });

  it('ignores the order field when a preset is chosen', async () => {
    const result = await executeTool(reorderTool, {
      files: [await doc(3)],
      params: { preset: 'reverse', order: 'nonsense!!' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P3', 'P2', 'P1']);
  });
});
