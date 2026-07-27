import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from './errors.ts';
import { parsePipelineSteps, runPipeline, shouldFanOut } from './pipeline.ts';
import { registry } from './registry.ts';
import { asInput, allPageText, samplePdf } from './testing/fixtures.ts';
import { ALL_TOOLS, registerAllTools } from './tools/index.ts';
import { getInfoTool } from './tools/edit/getInfo.ts';
import { rotateTool } from './tools/organize/rotate.ts';
import { splitTool } from './tools/organize/split.ts';
import { addWatermarkTool } from './tools/security/watermark.ts';

registerAllTools();

describe('shouldFanOut', () => {
  it('fans out when many files meet a single-input tool', () => {
    assert.equal(shouldFanOut(rotateTool, 3), true);
    assert.equal(shouldFanOut(rotateTool, 1), false);
  });

  it('does not fan out for multi-input tools', () => {
    const merge = registry.get('organize.merge');
    assert.equal(shouldFanOut(merge, 4), false);
  });
});

describe('parsePipelineSteps', () => {
  it('parses a valid steps array', () => {
    const steps = parsePipelineSteps(
      JSON.stringify([
        { toolId: 'organize.rotate', params: { degrees: '90' } },
        { toolId: 'security.watermark', params: { text: 'X' } },
      ]),
    );
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.toolId, 'organize.rotate');
  });

  it('rejects empty or invalid JSON', () => {
    assert.throws(() => parsePipelineSteps('[]'), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      return e.code === 'INVALID_PARAM';
    });
    assert.throws(() => parsePipelineSteps('not-json'), ToolError);
  });
});

describe('runPipeline', () => {
  it('chains rotate then watermark', async () => {
    const bytes = await samplePdf({ pages: 1, label: () => 'Body' });
    const result = await runPipeline({
      steps: [
        { toolId: 'organize.rotate', params: { degrees: '90' } },
        { toolId: 'security.add-watermark', params: { text: 'PIPE' } },
      ],
      files: [asInput(bytes, 'in.pdf')],
      resolveTool: (id) => registry.get(id),
    });

    assert.equal(result.files.length, 1);
    assert.ok(result.files[0]!.name.includes('watermark') || result.files[0]!.name.endsWith('.pdf'));
    assert.ok(allPageText(result.files[0]!.bytes).some((t) => t.includes('PIPE')));
    assert.equal(result.stepSummaries.length, 2);
  });

  it('fans out over split outputs for a single-input step', async () => {
    const bytes = await samplePdf({ pages: 4, label: (n) => `P${n}` });
    const result = await runPipeline({
      steps: [
        { toolId: 'organize.split', params: { mode: 'everyN', everyN: 2 } },
        // rotate accepts one PDF — must run once per split part
        { toolId: 'organize.rotate', params: { degrees: '180' } },
      ],
      files: [asInput(bytes, 'book.pdf')],
      resolveTool: (id) => registry.get(id),
    });

    assert.ok(result.files.length >= 2, `expected fan-out, got ${result.files.length}`);
  });

  it('rejects a report-only tool as a step', async () => {
    await assert.rejects(
      runPipeline({
        steps: [{ toolId: getInfoTool.id, params: {} }],
        files: [asInput(await samplePdf({ pages: 1 }), 'x.pdf')],
        resolveTool: (id) => registry.get(id),
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });

  it('reports progress across steps', async () => {
    const fractions: number[] = [];
    await runPipeline({
      steps: [{ toolId: 'organize.rotate', params: { degrees: '90' } }],
      files: [asInput(await samplePdf({ pages: 1 }), 'x.pdf')],
      resolveTool: (id) => registry.get(id),
      onProgress: (fraction) => fractions.push(fraction),
    });
    assert.ok(fractions.length > 0);
    assert.equal(fractions[fractions.length - 1], 1);
  });

  it('exposes every catalogue tool id that is pipelineable via registry', () => {
    const pipelineable = registry.pipelineTools();
    assert.ok(pipelineable.length > 10);
    assert.ok(pipelineable.every((t) => t.output !== 'report'));
    assert.ok(!pipelineable.some((t) => t.id === getInfoTool.id));
    // Sanity: catalogue is loaded
    assert.ok(ALL_TOOLS.length >= pipelineable.length);
  });
});

describe('split helper export smoke', () => {
  it('split tool is registered', () => {
    assert.equal(splitTool.id, 'organize.split');
    assert.equal(addWatermarkTool.category, 'security');
  });
});
