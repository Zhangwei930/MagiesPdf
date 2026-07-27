import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { allPageText, asInput, encryptPdf, samplePdf } from '../../testing/fixtures.ts';
import { mergeTool, sortFiles } from './merge.ts';

async function pdfNamed(name: string, labels: string[]) {
  const bytes = await samplePdf({ pages: labels.length, label: (n) => labels[n - 1] ?? '' });
  return asInput(bytes, name);
}

describe('sortFiles', () => {
  it('leaves the given order alone for "asIs"', async () => {
    const files = [await pdfNamed('b.pdf', ['B']), await pdfNamed('a.pdf', ['A'])];
    assert.deepEqual(sortFiles(files, 'asIs').map((f) => f.name), ['b.pdf', 'a.pdf']);
  });

  it('sorts numbers naturally rather than lexically', async () => {
    const files = [
      await pdfNamed('ch10.pdf', ['X']),
      await pdfNamed('ch2.pdf', ['X']),
      await pdfNamed('ch1.pdf', ['X']),
    ];
    assert.deepEqual(
      sortFiles(files, 'nameAsc').map((f) => f.name),
      ['ch1.pdf', 'ch2.pdf', 'ch10.pdf'],
    );
  });

  it('reverses for nameDesc', async () => {
    const files = [await pdfNamed('a.pdf', ['A']), await pdfNamed('b.pdf', ['B'])];
    assert.deepEqual(sortFiles(files, 'nameDesc').map((f) => f.name), ['b.pdf', 'a.pdf']);
  });
});

describe('organize.merge', () => {
  it('concatenates pages in list order', async () => {
    const result = await executeTool(mergeTool, {
      files: [await pdfNamed('a.pdf', ['A1', 'A2']), await pdfNamed('b.pdf', ['B1'])],
      params: {},
    });

    assert.equal(result.files.length, 1);
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['A1', 'A2', 'B1']);
  });

  it('honours the sort order over the list order', async () => {
    const result = await executeTool(mergeTool, {
      files: [await pdfNamed('z.pdf', ['Z']), await pdfNamed('a.pdf', ['A'])],
      params: { order: 'nameAsc' },
    });

    assert.deepEqual(allPageText(result.files[0]!.bytes), ['A', 'Z']);
  });

  it('names the output after the first source file', async () => {
    const result = await executeTool(mergeTool, {
      files: [await pdfNamed('report.pdf', ['A']), await pdfNamed('appendix.pdf', ['B'])],
      params: {},
    });

    assert.equal(result.files[0]!.name, 'report_merged.pdf');
  });

  it('merges more than two documents', async () => {
    const result = await executeTool(mergeTool, {
      files: [
        await pdfNamed('a.pdf', ['A']),
        await pdfNamed('b.pdf', ['B']),
        await pdfNamed('c.pdf', ['C']),
        await pdfNamed('d.pdf', ['D']),
      ],
      params: {},
    });

    assert.deepEqual(allPageText(result.files[0]!.bytes), ['A', 'B', 'C', 'D']);
  });

  it('merges encrypted sources when given the password', async () => {
    const plain = await samplePdf({ pages: 1, label: () => 'SECRET' });
    const locked = asInput(encryptPdf(plain, { userPassword: 'pw' }), 'locked.pdf');

    const result = await executeTool(mergeTool, {
      files: [locked, await pdfNamed('open.pdf', ['OPEN'])],
      params: { password: 'pw' },
    });

    assert.deepEqual(allPageText(result.files[0]!.bytes), ['SECRET', 'OPEN']);
  });

  it('never carries a source password into the merged output', async () => {
    const plain = await samplePdf({ pages: 1, label: () => 'S' });
    const locked = asInput(encryptPdf(plain, { userPassword: 'pw' }), 'locked.pdf');

    const result = await executeTool(mergeTool, {
      files: [locked, await pdfNamed('open.pdf', ['O'])],
      params: { password: 'pw' },
    });

    // Reading without a password must succeed.
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['S', 'O']);
  });

  it('reports a missing password rather than failing obscurely', async () => {
    const locked = asInput(encryptPdf(await samplePdf({ pages: 1 }), { userPassword: 'pw' }), 'l.pdf');

    await assert.rejects(
      executeTool(mergeTool, { files: [locked, await pdfNamed('b.pdf', ['B'])], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'PASSWORD_REQUIRED');
        return true;
      },
    );
  });

  it('refuses a single file, since there is nothing to merge', async () => {
    await assert.rejects(
      executeTool(mergeTool, { files: [await pdfNamed('a.pdf', ['A'])], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_INPUT');
        return true;
      },
    );
  });

  it('rejects a non-PDF input', async () => {
    const notPdf = asInput(new TextEncoder().encode('hello'), 'notes.txt', 'text/plain');
    await assert.rejects(
      executeTool(mergeTool, { files: [notPdf, await pdfNamed('a.pdf', ['A'])], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'UNSUPPORTED_FORMAT');
        return true;
      },
    );
  });

  it('reports progress that ends at 1', async () => {
    const seen: number[] = [];
    await executeTool(mergeTool, {
      files: [await pdfNamed('a.pdf', ['A']), await pdfNamed('b.pdf', ['B'])],
      params: {},
      onProgress: (fraction) => seen.push(fraction),
    });

    assert.ok(seen.length > 0);
    assert.equal(seen.at(-1), 1);
    assert.ok(seen.every((f) => f >= 0 && f <= 1));
  });

  it('stops when the job is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      executeTool(mergeTool, {
        files: [await pdfNamed('a.pdf', ['A']), await pdfNamed('b.pdf', ['B'])],
        params: {},
        signal: controller.signal,
      }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'CANCELLED');
        return true;
      },
    );
  });
});
