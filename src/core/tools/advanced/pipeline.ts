import { parsePipelineSteps, runPipeline } from '../../pipeline.ts';
import { registry } from '../../registry.ts';
import type { ToolDescriptor } from '../../types.ts';

/**
 * No-code pipeline: run several tools in order, chaining each step's output
 * files into the next. Steps are supplied as JSON so the REST API, saved
 * definitions and the visual builder all share one wire format:
 *
 *   [{"toolId":"organize.rotate","params":{"degrees":"90"}},
 *    {"toolId":"security.watermark","params":{"text":"CONFIDENTIAL"}}]
 */
export const pipelineTool: ToolDescriptor = {
  id: 'advanced.pipeline',
  category: 'advanced',
  name: { zh: '流水线', en: 'Pipeline' },
  description: {
    zh: '把多个工具串成一条流水线，上一步的输出自动成为下一步的输入。',
    en: 'Chain several tools into one run — each step feeds the next.',
  },
  icon: 'Workflow',
  keywords: ['pipeline', 'workflow', 'chain', 'automate', '流水线', '工作流', '串联', '自动化'],
  input: {
    accept: [
      '.pdf',
      '.png',
      '.jpg',
      '.jpeg',
      '.md',
      '.markdown',
      '.html',
      '.htm',
      '.txt',
      '.csv',
      '.docx',
      '.xlsx',
      '.pptx',
    ],
    min: 1,
    max: null,
    ordered: true,
  },
  output: 'multiple',
  // Main so host-backed convert steps (docx/md → PDF) can participate.
  runtime: 'main',
  // Nested pipelines are not supported (and would make the palette recursive).
  pipelineable: false,
  params: [
    {
      key: 'steps',
      type: 'text',
      label: { zh: '步骤（JSON）', en: 'Steps (JSON)' },
      help: {
        zh: '数组，每项含 toolId 与可选 params。应用内可用可视化编辑器代替手写。',
        en: 'An array of { toolId, params? }. The app UI can build this for you.',
      },
      default: '[]',
      multiline: true,
      required: true,
    },
  ],

  async run(ctx) {
    const steps = parsePipelineSteps(String(ctx.params.steps ?? '[]'));

    const result = await runPipeline({
      steps,
      files: ctx.files,
      resolveTool: (id) => registry.get(id),
      host: ctx.host,
      signal: ctx.signal,
      onProgress: (fraction, message) => ctx.report(fraction, message),
    });

    return {
      files: result.files,
      summary: result.summary,
      data: { stepSummaries: result.stepSummaries },
    };
  },
};
