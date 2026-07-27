import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { registerAllTools } from '../index.ts';
import { batchTool } from './batch.ts';
import { pipelineTool } from './pipeline.ts';

registerAllTools();

describe('advanced.pipeline', () => {
  it('runs a two-step chain via the tool descriptor', async () => {
    const result = await executeTool(pipelineTool, {
      files: [asInput(await samplePdf({ pages: 1, label: () => 'X' }), 'a.pdf')],
      params: {
        steps: JSON.stringify([
          { toolId: 'organize.rotate', params: { degrees: '90' } },
          { toolId: 'security.add-watermark', params: { text: 'BATCH' } },
        ]),
      },
      // pipeline is runtime:main but watermark/rotate are pure worker tools;
      // host is unused for these steps. executeTool only requires host when
      // the *outer* tool is main — supply a stub.
      host: {
        htmlToPdf: async () => new Uint8Array(),
        externalConvert: async () => {
          throw new Error('n/a');
        },
        hasExternalConverter: () => false,
      },
    });

    assert.ok(result.files.length >= 1);
    assert.ok(allPageText(result.files[0]!.bytes).some((t) => t.includes('BATCH')));
  });

  it('rejects empty steps JSON', async () => {
    await assert.rejects(
      executeTool(pipelineTool, {
        files: [asInput(await samplePdf({ pages: 1 }), 'a.pdf')],
        params: { steps: '[]' },
        host: {
          htmlToPdf: async () => new Uint8Array(),
          externalConvert: async () => {
            throw new Error('n/a');
          },
          hasExternalConverter: () => false,
        },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });
});

describe('advanced.batch', () => {
  it('applies a tool to each input file', async () => {
    const result = await executeTool(batchTool, {
      files: [
        asInput(await samplePdf({ pages: 1, label: () => 'A' }), 'a.pdf'),
        asInput(await samplePdf({ pages: 1, label: () => 'B' }), 'b.pdf'),
      ],
      params: {
        toolId: 'security.add-watermark',
        toolParams: JSON.stringify({ text: 'WM' }),
      },
      host: {
        htmlToPdf: async () => new Uint8Array(),
        externalConvert: async () => {
          throw new Error('n/a');
        },
        hasExternalConverter: () => false,
      },
    });

    assert.equal(result.files.length, 2);
    for (const file of result.files) {
      assert.ok(allPageText(file.bytes).some((t) => t.includes('WM')));
    }
  });

  it('refuses multi-input target tools', async () => {
    await assert.rejects(
      executeTool(batchTool, {
        files: [asInput(await samplePdf({ pages: 1 }), 'a.pdf')],
        params: { toolId: 'organize.merge', toolParams: '{}' },
        host: {
          htmlToPdf: async () => new Uint8Array(),
          externalConvert: async () => {
            throw new Error('n/a');
          },
          hasExternalConverter: () => false,
        },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });
});
