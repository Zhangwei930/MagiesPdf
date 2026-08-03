const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createOfficePreview } = require('./preview.cjs');

function dependencies(overrides = {}) {
  const calls = { rendered: [], discarded: [], read: [] };
  const deps = {
    x2t: {
      toPdf: async (sourcePath) => {
        calls.rendered.push(sourcePath);
        return { pdfPath: '/tmp/magies/j1/preview.pdf', workDir: '/tmp/magies/j1' };
      },
      discard: async (workDir) => calls.discarded.push(workDir),
    },
    fs: {
      readFile: async (target) => {
        calls.read.push(target);
        return Buffer.from('%PDF-1.7 rendered');
      },
      stat: async () => ({ isFile: () => true, size: 17 }),
    },
    ...overrides,
  };
  return { calls, deps };
}

describe('Office preview', () => {
  /**
   * The tab is showing the document the user opened, not the rendering that
   * happens to be behind it. Naming it `.pdf` makes an implementation detail
   * look like a conversion the user did not ask for.
   */
  it('keeps the name of the document that was opened', async () => {
    const { calls, deps } = dependencies();
    const preview = createOfficePreview(deps);

    const [file] = await preview.render(['/docs/报告.docx']);

    assert.equal(file.name, '报告.docx');
    assert.equal(file.mime, 'application/pdf');
    assert.equal(Buffer.from(file.bytes).toString(), '%PDF-1.7 rendered');
    assert.deepEqual(calls.rendered, ['/docs/报告.docx']);
  });

  /** The tab has to know which file it is showing, and of what kind. */
  it('reports the source file and its kind', async () => {
    const { deps } = dependencies();
    const preview = createOfficePreview(deps);

    const [word] = await preview.render(['/docs/a.docx']);
    const [sheet] = await preview.render(['/docs/b.xlsx']);
    const [slide] = await preview.render(['/docs/c.pptx']);

    assert.deepEqual(word.origin, { path: '/docs/a.docx', kind: 'word' });
    assert.equal(sheet.origin.kind, 'sheet');
    assert.equal(slide.origin.kind, 'slide');
  });

  /** Bytes are in hand once read; leaving the render on disk leaks the document. */
  it('removes the work directory once the bytes are read', async () => {
    const { calls, deps } = dependencies();
    const preview = createOfficePreview(deps);

    await preview.render(['/docs/a.docx']);

    assert.deepEqual(calls.discarded, ['/tmp/magies/j1']);
  });

  it('cleans up even when reading the render fails', async () => {
    const { calls, deps } = dependencies({
      fs: {
        readFile: async () => {
          throw new Error('disk gone');
        },
        stat: async () => ({ isFile: () => true, size: 0 }),
      },
    });
    const preview = createOfficePreview(deps);

    await assert.rejects(() => preview.render(['/docs/a.docx']), /disk gone/);
    assert.deepEqual(calls.discarded, ['/tmp/magies/j1']);
  });

  it('renders every path it is given', async () => {
    const { calls, deps } = dependencies();
    const preview = createOfficePreview(deps);

    const files = await preview.render(['/docs/a.docx', '/docs/b.pptx']);

    assert.equal(files.length, 2);
    assert.deepEqual(calls.rendered, ['/docs/a.docx', '/docs/b.pptx']);
  });

  it('refuses a relative path', async () => {
    const { deps } = dependencies();
    const preview = createOfficePreview(deps);
    await assert.rejects(() => preview.render(['docs/a.docx']), /absolute/i);
  });

  it('refuses a file no editor can open', async () => {
    const { deps } = dependencies();
    const preview = createOfficePreview(deps);
    await assert.rejects(() => preview.render(['/docs/a.txt']), /unsupported/i);
  });
});
