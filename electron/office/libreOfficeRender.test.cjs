const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');
const { createLibreOfficeRenderer } = require('./libreOfficeRender.cjs');

function dependencies(overrides = {}) {
  const calls = { ran: [], made: [], removed: [] };
  const deps = {
    executable: '/opt/libreoffice/soffice',
    tempRoot: '/tmp/magies',
    fs: {
      mkdir: async (target) => calls.made.push(target),
      rm: async (target) => calls.removed.push(target),
      access: async () => undefined,
    },
    run: async (executable, args) => {
      calls.ran.push([executable, args]);
      return { code: 0 };
    },
    uniqueId: () => 'job1',
    ...overrides,
  };
  return { calls, deps };
}

describe('LibreOffice renderer', () => {
  it('renders a document to PDF in its own work directory', async () => {
    const { calls, deps } = dependencies();
    const renderer = createLibreOfficeRenderer(deps);

    const result = await renderer.toPdf('/docs/报告.docx');

    assert.equal(result.workDir, path.join('/tmp/magies', 'job1'));
    assert.equal(result.pdfPath, path.join('/tmp/magies', 'job1', '报告.pdf'));

    const [executable, args] = calls.ran[0];
    assert.equal(executable, '/opt/libreoffice/soffice');
    assert.ok(args.includes('--headless'), 'must not open a window');
    assert.ok(args.includes('--convert-to'), 'must be a conversion');
    assert.ok(args.includes('/docs/报告.docx'));
  });

  /**
   * LibreOffice refuses to start a second time against a profile already in
   * use, so two documents opening at once would fail unless each conversion
   * gets its own. The profile lives in the work directory and dies with it.
   */
  it('gives every conversion its own profile', async () => {
    const { calls, deps } = dependencies();
    const renderer = createLibreOfficeRenderer(deps);

    await renderer.toPdf('/docs/a.docx');

    const [, args] = calls.ran[0];
    const profile = args.find((value) => value.startsWith('-env:UserInstallation='));
    assert.ok(profile, 'no profile was given');
    assert.ok(profile.includes('job1'), 'the profile is not per conversion');
    assert.ok(profile.includes('file://'), 'LibreOffice needs a URL, not a path');
  });

  it('reports a conversion failure instead of a missing file later', async () => {
    const { deps } = dependencies({ run: async () => ({ code: 1, stderr: 'boom' }) });
    const renderer = createLibreOfficeRenderer(deps);
    await assert.rejects(() => renderer.toPdf('/docs/a.docx'), /LibreOffice failed/i);
  });

  /** A conversion that exits 0 but wrote nothing must not look like success. */
  it('reports when nothing was produced', async () => {
    const { deps } = dependencies({
      fs: {
        mkdir: async () => undefined,
        rm: async () => undefined,
        access: async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
      },
    });
    const renderer = createLibreOfficeRenderer(deps);
    await assert.rejects(() => renderer.toPdf('/docs/a.docx'), /produced no PDF/i);
  });

  it('refuses a relative path', async () => {
    const { deps } = dependencies();
    const renderer = createLibreOfficeRenderer(deps);
    await assert.rejects(() => renderer.toPdf('docs/a.docx'), /absolute/i);
  });

  it('refuses a format no editor can open', async () => {
    const { deps } = dependencies();
    const renderer = createLibreOfficeRenderer(deps);
    await assert.rejects(() => renderer.toPdf('/docs/a.txt'), /unsupported/i);
  });

  it('says so plainly when no LibreOffice was found', async () => {
    const { deps } = dependencies({ executable: '' });
    const renderer = createLibreOfficeRenderer(deps);
    await assert.rejects(() => renderer.toPdf('/docs/a.docx'), /not available/i);
  });

  it('removes a work directory, but only inside its own temp root', async () => {
    const { calls, deps } = dependencies();
    const renderer = createLibreOfficeRenderer(deps);

    await renderer.discard('/tmp/magies/job1');
    assert.deepEqual(calls.removed, [path.resolve('/tmp/magies/job1')]);

    await assert.rejects(() => renderer.discard('/Users/someone/Documents'), /temp/i);
  });
});
