import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MagiesPdfBridge } from '../bridge.ts';
import { createDefaultBlankPdf } from './directEdit.ts';

describe('createDefaultBlankPdf', () => {
  it('creates one A4 page and returns it as an unsaved editor document', async () => {
    const calls: unknown[] = [];
    const api = {
      runJob: async (request: unknown) => {
        calls.push(request);
        return {
          files: [{ name: 'untitled.pdf', mime: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }],
        };
      },
    } as unknown as MagiesPdfBridge;

    const file = await createDefaultBlankPdf(api, 'job-1');

    assert.deepEqual(calls, [{
      jobId: 'job-1',
      toolId: 'edit.create-blank',
      files: [],
      params: { pages: 1, pageSize: 'a4', labelPages: false, fileName: 'untitled.pdf' },
    }]);
    assert.equal(file.name, 'untitled.pdf');
    assert.equal(file.path, '');
    assert.equal(file.size, 3);
  });

  it('fails loudly when the PDF engine returns no file', async () => {
    const api = { runJob: async () => ({ files: [] }) } as unknown as MagiesPdfBridge;
    await assert.rejects(createDefaultBlankPdf(api, 'job-2'), /produced no PDF/);
  });
});
