import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { addHeaderFooterTool } from './headerFooter.ts';

describe('edit.add-header-footer', () => {
  it('stamps header and footer text onto pages', async () => {
    const result = await executeTool(addHeaderFooterTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (n) => `Body${n}` }), 'd.pdf')],
      params: {
        header: 'CONFIDENTIAL',
        footer: 'Page {n} of {total}',
        align: 'center',
      },
    });

    assert.equal(result.files[0]!.name, 'd_headed.pdf');
    const texts = allPageText(result.files[0]!.bytes);
    assert.ok(texts.some((t) => t.includes('CONFIDENTIAL')));
    assert.ok(texts.some((t) => t.includes('Page 1 of 2') || t.includes('Page 2 of 2')));
  });

  it('rejects empty header and footer', async () => {
    await assert.rejects(
      executeTool(addHeaderFooterTool, {
        files: [asInput(await samplePdf({ pages: 1 }), 'd.pdf')],
        params: { header: '', footer: '' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });
});
