import { ToolError } from '../../errors.ts';
import { runSubTool } from '../../subTool.ts';
import { registry } from '../../registry.ts';
import type { ToolDescriptor, ToolOutputFile } from '../../types.ts';
import { reportStep } from '../shared.ts';

/**
 * Apply one tool to many files, one at a time.
 *
 * The target tool must accept a single input (`max === 1`). Multi-input tools
 * like merge belong in a pipeline step instead.
 */
export const batchTool: ToolDescriptor = {
  id: 'advanced.batch',
  category: 'advanced',
  name: { zh: '批量处理', en: 'Batch Process' },
  description: {
    zh: '对一批文件逐个执行同一个工具（例如批量压缩、批量加水印）。',
    en: 'Run the same tool on each file in a batch (compress, watermark, rotate, …).',
  },
  icon: 'Layers',
  keywords: ['batch', 'bulk', 'many', 'foreach', '批量', '批处理', '多个'],
  input: {
    accept: [
      '.pdf',
      '.png',
      '.jpg',
      '.jpeg',
      '.md',
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
  runtime: 'main',
  pipelineable: false,
  params: [
    {
      key: 'toolId',
      type: 'text',
      label: { zh: '目标工具 ID', en: 'Target tool id' },
      help: {
        zh: '例如 organize.rotate 或 security.watermark。应用内可用下拉选择。',
        en: 'e.g. organize.rotate or security.watermark. The app UI offers a picker.',
      },
      default: 'security.add-watermark',
      required: true,
    },
    {
      key: 'toolParams',
      type: 'text',
      label: { zh: '工具参数（JSON）', en: 'Tool params (JSON)' },
      default: '{"text":"CONFIDENTIAL"}',
      multiline: true,
      advanced: true,
    },
  ],

  async run(ctx) {
    const toolId = String(ctx.params.toolId ?? '').trim();
    if (!toolId) {
      throw new ToolError('INVALID_PARAM', 'toolId is required', {
        zh: '请指定要批量执行的工具。',
        en: 'Choose a tool to run on each file.',
      });
    }

    const tool = registry.get(toolId);
    if (tool.output === 'report' || tool.pipelineable === false) {
      throw new ToolError('INVALID_PARAM', `${toolId} cannot be batched`, {
        zh: `「${tool.name.zh}」不能用于批量处理。`,
        en: `"${tool.name.en}" cannot be used in batch mode.`,
      });
    }
    if (tool.input.max !== 1) {
      throw new ToolError(
        'INVALID_PARAM',
        `${toolId} accepts multiple files; use a pipeline or call it directly`,
        {
          zh: `「${tool.name.zh}」一次吃多个文件，请直接使用该工具或改用流水线。`,
          en: `"${tool.name.en}" takes multiple files at once — use it directly or a pipeline.`,
        },
      );
    }

    let params: Record<string, unknown> = {};
    const rawParams = String(ctx.params.toolParams ?? '{}').trim() || '{}';
    try {
      const parsed = JSON.parse(rawParams) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      params = parsed as Record<string, unknown>;
    } catch {
      throw new ToolError('INVALID_PARAM', 'toolParams must be a JSON object', {
        zh: '工具参数必须是 JSON 对象。',
        en: 'Tool params must be a JSON object.',
      });
    }

    const outputs: ToolOutputFile[] = [];
    const total = ctx.files.length;

    for (let i = 0; i < total; i += 1) {
      const file = ctx.files[i];
      if (!file) continue;
      reportStep(ctx, i, total, {
        zh: `正在处理 ${file.name}（${i + 1}/${total}）`,
        en: `Processing ${file.name} (${i + 1}/${total})`,
      });

      // Off the main process where the tool allows it — this tool has to be
      // `runtime: 'main'` for the sake of steps that need the host, and doing
      // every step's work here froze the window for the length of the batch.
      const result = await runSubTool(tool, {
        files: [file],
        params,
        host: ctx.host,
        signal: ctx.signal,
      });
      outputs.push(...result.files);
    }

    reportStep(ctx, total, total);
    return {
      files: outputs,
      summary: {
        zh: `已对 ${total} 个文件执行「${tool.name.zh}」，得到 ${outputs.length} 个输出`,
        en: `Ran "${tool.name.en}" on ${total} file(s) → ${outputs.length} output(s)`,
      },
    };
  },
};
