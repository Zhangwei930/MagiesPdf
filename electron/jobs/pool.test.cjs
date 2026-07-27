const assert = require('node:assert/strict');
const fs = require('node:fs');
const { after, before, describe, it } = require('node:test');
const { JobPool, WORKER_ENTRY, defaultPoolSize } = require('./pool.cjs');

/**
 * End-to-end coverage of the worker pool against the real built worker bundle,
 * with no Electron involved. This is the seam most likely to break silently —
 * a bad transfer list or a protocol drift shows up here rather than in the app.
 */

const built = fs.existsSync(WORKER_ENTRY);
const skip = built ? false : 'run `npm run build:node` first';

/** Two tiny valid PDFs, built by the worker itself is overkill — hand-roll instead. */
function minimalPdf(label) {
  const content = `BT /F1 24 Tf 72 700 Td (${label}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function file(name, label) {
  return { name, bytes: minimalPdf(label), mime: 'application/pdf' };
}

describe('JobPool', { skip }, () => {
  /** @type {JobPool} */
  let pool;

  before(() => {
    pool = new JobPool(2);
  });

  after(async () => {
    await pool.destroy();
  });

  it('runs a merge job in a worker and returns the output bytes', async () => {
    const result = await pool.run({
      jobId: 'j1',
      toolId: 'organize.merge',
      files: [file('a.pdf', 'A'), file('b.pdf', 'B')],
      params: {},
    });

    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, 'a_merged.pdf');
    assert.ok(result.files[0].bytes.length > 0);
    assert.equal(Buffer.from(result.files[0].bytes.slice(0, 5)).toString('latin1'), '%PDF-');
  });

  it('reports progress before completing', async () => {
    const seen = [];
    await pool.run(
      {
        jobId: 'j2',
        toolId: 'organize.merge',
        files: [file('a.pdf', 'A'), file('b.pdf', 'B')],
        params: {},
      },
      (fraction) => seen.push(fraction),
    );

    assert.ok(seen.length > 0, 'expected at least one progress report');
    assert.equal(seen.at(-1), 1);
  });

  it('rejects with a serialized ToolError the renderer can switch on', async () => {
    await assert.rejects(
      pool.run({ jobId: 'j3', toolId: 'organize.merge', files: [file('a.pdf', 'A')], params: {} }),
      (error) => {
        assert.equal(error.__toolError, true);
        assert.equal(error.code, 'INVALID_INPUT');
        assert.equal(typeof error.userMessage.zh, 'string');
        return true;
      },
    );
  });

  it('rejects an unknown tool id', async () => {
    await assert.rejects(
      pool.run({ jobId: 'j4', toolId: 'nope.nope', files: [file('a.pdf', 'A')], params: {} }),
      (error) => {
        assert.equal(error.__toolError, true);
        return true;
      },
    );
  });

  it('runs queued jobs concurrently across workers', async () => {
    const jobs = Array.from({ length: 6 }, (_, i) =>
      pool.run({
        jobId: `c${i}`,
        toolId: 'organize.merge',
        files: [file('a.pdf', 'A'), file('b.pdf', 'B')],
        params: {},
      }),
    );

    const results = await Promise.all(jobs);
    assert.equal(results.length, 6);
    for (const result of results) assert.equal(result.files.length, 1);
  });

  it('cancels a queued job before it starts', async () => {
    const small = new JobPool(1);
    try {
      const first = small.run({
        jobId: 'q1',
        toolId: 'organize.split',
        files: [file('a.pdf', 'A')],
        params: { mode: 'everyN', everyN: 1 },
      });
      const second = small.run({
        jobId: 'q2',
        toolId: 'organize.merge',
        files: [file('a.pdf', 'A'), file('b.pdf', 'B')],
        params: {},
      });

      assert.equal(small.cancel('q2'), true);
      await assert.rejects(second, (error) => {
        assert.equal(error.code, 'CANCELLED');
        return true;
      });
      // The single-page split fails on its own terms; either way the pool survives.
      await first.catch(() => {});
    } finally {
      await small.destroy();
    }
  });

  it('reports cancel as false for a job it has never seen', () => {
    assert.equal(pool.cancel('who-is-this'), false);
  });

  it('rejects new work after destroy', async () => {
    const dead = new JobPool(1);
    await dead.destroy();
    await assert.rejects(
      dead.run({ jobId: 'x', toolId: 'organize.merge', files: [], params: {} }),
      /destroyed/,
    );
  });
});

describe('defaultPoolSize', () => {
  it('stays within one and four', () => {
    const size = defaultPoolSize();
    assert.ok(size >= 1 && size <= 4, `got ${size}`);
  });
});
