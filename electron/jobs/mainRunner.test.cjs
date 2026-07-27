const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cancel, run } = require('./mainRunner.cjs');

describe('main-process job cancellation', () => {
  it('can cancel while the core bundle is still loading', async () => {
    const jobId = 'cancel-during-load';
    const pending = run(
      {
        jobId,
        toolId: 'convert.html-to-pdf',
        files: [
          {
            name: 'page.html',
            mime: 'text/html',
            bytes: new TextEncoder().encode('<p>test</p>'),
          },
        ],
        params: {},
      },
      {
        htmlToPdf: async () => new Uint8Array([1]),
        externalConvert: async () => {
          throw new Error('not used');
        },
        hasExternalConverter: () => false,
      },
      () => {},
    );

    assert.equal(cancel(jobId), true);
    await assert.rejects(
      pending,
      (error) => error?.__toolError === true && error.code === 'CANCELLED',
    );
  });
});
