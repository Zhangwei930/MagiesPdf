import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { packBySize, splitAfterPages, splitEveryN, splitIntoParts, splitTool } from './split.ts';

const doc = async (pages: number, name = 'report.pdf') =>
  asInput(await samplePdf({ pages, label: (n) => `P${n}` }), name);

describe('splitEveryN', () => {
  it('chops into equal runs', () => {
    assert.deepEqual(splitEveryN(6, 2), [[1, 2], [3, 4], [5, 6]]);
  });

  it('leaves a short final run', () => {
    assert.deepEqual(splitEveryN(5, 2), [[1, 2], [3, 4], [5]]);
  });

  it('produces one file per page for a size of 1', () => {
    assert.deepEqual(splitEveryN(3, 1), [[1], [2], [3]]);
  });

  it('produces a single run when the size exceeds the document', () => {
    assert.deepEqual(splitEveryN(3, 99), [[1, 2, 3]]);
  });
});

describe('splitAfterPages', () => {
  it('cuts after the named pages', () => {
    assert.deepEqual(splitAfterPages(8, [3, 5]), [[1, 2, 3], [4, 5], [6, 7, 8]]);
  });

  it('ignores a cut at the last page rather than emitting an empty file', () => {
    assert.deepEqual(splitAfterPages(4, [4]), [[1, 2, 3, 4]]);
  });

  it('ignores duplicate and unsorted cut points', () => {
    assert.deepEqual(splitAfterPages(6, [4, 2, 2]), [[1, 2], [3, 4], [5, 6]]);
  });

  it('returns the whole document when there are no cuts', () => {
    assert.deepEqual(splitAfterPages(3, []), [[1, 2, 3]]);
  });
});

describe('splitIntoParts', () => {
  it('divides evenly when it can', () => {
    assert.deepEqual(splitIntoParts(6, 3), [[1, 2], [3, 4], [5, 6]]);
  });

  it('puts the remainder in the earliest parts', () => {
    assert.deepEqual(splitIntoParts(7, 3), [[1, 2, 3], [4, 5], [6, 7]]);
  });

  it('never asks for more parts than there are pages', () => {
    assert.deepEqual(splitIntoParts(2, 5), [[1], [2]]);
  });
});

describe('packBySize', () => {
  it('fills a file until the next page would exceed the limit', () => {
    assert.deepEqual(packBySize([40, 40, 40, 40], 100), [[1, 2], [3, 4]]);
  });

  it('gives an oversized page its own file instead of failing', () => {
    assert.deepEqual(packBySize([10, 500, 10], 100), [[1], [2], [3]]);
  });

  it('returns one file when everything fits', () => {
    assert.deepEqual(packBySize([10, 10], 100), [[1, 2]]);
  });
});

describe('organize.split', () => {
  it('splits every N pages and names outputs in sorted order', async () => {
    const result = await executeTool(splitTool, {
      files: [await doc(5)],
      params: { mode: 'everyN', everyN: 2 },
    });

    assert.deepEqual(result.files.map((f) => f.name), [
      'report_1.pdf',
      'report_2.pdf',
      'report_3.pdf',
    ]);
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P2']);
    assert.deepEqual(allPageText(result.files[2]!.bytes), ['P5']);
  });

  it('zero-pads names once there are ten or more outputs', async () => {
    const result = await executeTool(splitTool, {
      files: [await doc(12)],
      params: { mode: 'everyN', everyN: 1 },
    });

    assert.equal(result.files[0]!.name, 'report_01.pdf');
    assert.equal(result.files[11]!.name, 'report_12.pdf');
  });

  it('splits after the given pages', async () => {
    const result = await executeTool(splitTool, {
      files: [await doc(6)],
      params: { mode: 'after', after: '2,4' },
    });

    assert.equal(result.files.length, 3);
    assert.deepEqual(allPageText(result.files[1]!.bytes), ['P3', 'P4']);
  });

  it('splits into equal parts', async () => {
    const result = await executeTool(splitTool, {
      files: [await doc(7)],
      params: { mode: 'parts', parts: 3 },
    });

    assert.deepEqual(
      result.files.map((f) => allPageText(f.bytes).length),
      [3, 2, 2],
    );
  });

  it('splits by size into more than one file', async () => {
    // ~10 KB of content per page, so a 0.1 MB cap has to cut somewhere.
    const result = await executeTool(splitTool, {
      files: [asInput(await samplePdf({ pages: 20, bodyLines: 150 }), 'big.pdf')],
      params: { mode: 'size', sizeLimitMb: 0.1 },
    });

    assert.ok(result.files.length > 1, `expected several files, got ${result.files.length}`);
    const totalPages = result.files.reduce((n, f) => n + allPageText(f.bytes).length, 0);
    assert.equal(totalPages, 20);
  });

  it('preserves every page across all outputs', async () => {
    const result = await executeTool(splitTool, {
      files: [await doc(9)],
      params: { mode: 'everyN', everyN: 4 },
    });

    assert.deepEqual(
      result.files.flatMap((f) => allPageText(f.bytes)),
      ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'],
    );
  });

  it('refuses a single-page document', async () => {
    await assert.rejects(
      executeTool(splitTool, { files: [await doc(1)], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_INPUT');
        return true;
      },
    );
  });

  it('rejects a cut point beyond the document', async () => {
    await assert.rejects(
      executeTool(splitTool, { files: [await doc(3)], params: { mode: 'after', after: '9' } }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'PAGE_OUT_OF_RANGE');
        return true;
      },
    );
  });

  it('rejects a page count below one', async () => {
    await assert.rejects(
      executeTool(splitTool, { files: [await doc(4)], params: { mode: 'everyN', everyN: 0 } }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_PARAM');
        return true;
      },
    );
  });
});
