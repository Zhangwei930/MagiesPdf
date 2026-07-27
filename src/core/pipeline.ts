import { ToolError } from './errors.ts';
import { executeTool, type ExecuteOptions } from './execute.ts';
import type {
  HostBridge,
  LocalizedText,
  ToolDescriptor,
  ToolInputFile,
  ToolResult,
} from './types.ts';

/**
 * A single node in a no-code pipeline.
 *
 * Params are raw values (same shape the REST API and the form produce); they are
 * re-validated against the tool's descriptor on every run so a saved pipeline
 * cannot smuggle unknown keys into a tool that no longer declares them.
 */
export interface PipelineStep {
  toolId: string;
  params?: Record<string, unknown>;
}

export interface PipelineOptions {
  steps: readonly PipelineStep[];
  files: readonly ToolInputFile[];
  /** Resolve a tool by id — typically `registry.get`. */
  resolveTool(toolId: string): ToolDescriptor;
  host?: HostBridge;
  signal?: AbortSignal;
  /**
   * `fraction` is overall 0..1 across every step (and every fan-out leg).
   * `message` names the step currently running.
   */
  onProgress?: (fraction: number, message?: LocalizedText) => void;
}

export interface PipelineResult extends ToolResult {
  /** One summary per step, in order. Fan-out legs of the same step share one entry. */
  stepSummaries: LocalizedText[];
}

/**
 * Runs tools in sequence, feeding each step the files produced by the previous.
 *
 * Fan-out: when a step produces N files and the next tool accepts at most one
 * (`input.max === 1`), the next tool is run once per file and the outputs are
 * concatenated. Tools that accept many files (merge, image-to-pdf, …) receive
 * the whole list instead.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { steps, resolveTool, host, signal, onProgress } = options;

  if (steps.length === 0) {
    throw new ToolError('INVALID_PARAM', 'Pipeline has no steps', {
      zh: '流水线至少需要一个步骤。',
      en: 'A pipeline needs at least one step.',
    });
  }

  if (options.files.length === 0) {
    throw new ToolError('INVALID_INPUT', 'Pipeline has no input files', {
      zh: '请先选择要处理的文件。',
      en: 'Choose at least one input file.',
    });
  }

  const descriptors = steps.map((step, index) => {
    const tool = resolveTool(step.toolId);
    assertPipelineable(tool, index);
    return tool;
  });

  let current: ToolInputFile[] = options.files.map(cloneFile);
  const stepSummaries: LocalizedText[] = [];
  const totalUnits = descriptors.length;

  for (let i = 0; i < descriptors.length; i += 1) {
    if (signal?.aborted) {
      throw new ToolError('CANCELLED', 'Pipeline cancelled', {
        zh: '流水线已取消。',
        en: 'The pipeline was cancelled.',
      });
    }

    const tool = descriptors[i] as ToolDescriptor;
    const step = steps[i] as PipelineStep;
    const params = step.params ?? {};
    const baseFraction = i / totalUnits;
    const stepWeight = 1 / totalUnits;

    const label: LocalizedText = {
      zh: `步骤 ${i + 1}/${totalUnits}：${tool.name.zh}`,
      en: `Step ${i + 1}/${totalUnits}: ${tool.name.en}`,
    };
    onProgress?.(baseFraction, label);

    const executeOptions = (files: ToolInputFile[]): ExecuteOptions => ({
      files,
      params,
      host,
      signal,
      onProgress: (fraction, message) => {
        onProgress?.(baseFraction + fraction * stepWeight, message ?? label);
      },
    });

    let result: ToolResult;

    if (shouldFanOut(tool, current.length)) {
      const allFiles: ToolInputFile[] = [];
      let lastSummary: LocalizedText | undefined;
      for (let f = 0; f < current.length; f += 1) {
        const file = current[f] as ToolInputFile;
        const leg = await executeTool(tool, executeOptions([file]));
        allFiles.push(...leg.files.map(asInputFile));
        lastSummary = leg.summary;
        onProgress?.(
          baseFraction + ((f + 1) / current.length) * stepWeight,
          {
            zh: `${label.zh}（${f + 1}/${current.length}）`,
            en: `${label.en} (${f + 1}/${current.length})`,
          },
        );
      }
      result = {
        files: allFiles,
        summary: lastSummary ?? {
          zh: `已对 ${current.length} 个文件执行「${tool.name.zh}」`,
          en: `Ran "${tool.name.en}" on ${current.length} files`,
        },
      };
    } else {
      result = await executeTool(tool, executeOptions(current));
    }

    if (result.files.length === 0) {
      throw new ToolError(
        'EMPTY_RESULT',
        `Pipeline step ${i + 1} (${tool.id}) produced no files`,
        {
          zh: `步骤 ${i + 1}「${tool.name.zh}」没有产生输出文件，流水线中止。`,
          en: `Step ${i + 1} ("${tool.name.en}") produced no files — pipeline stopped.`,
        },
      );
    }

    stepSummaries.push(
      result.summary ?? {
        zh: `完成「${tool.name.zh}」`,
        en: `Finished "${tool.name.en}"`,
      },
    );
    current = result.files.map(asInputFile);
  }

  onProgress?.(1, {
    zh: `流水线完成，共 ${steps.length} 步`,
    en: `Pipeline finished (${steps.length} steps)`,
  });

  return {
    files: current.map((file) => ({
      name: file.name,
      bytes: file.bytes,
      mime: file.mime,
    })),
    stepSummaries,
    summary: {
      zh: `流水线完成：${steps.length} 步 → ${current.length} 个文件`,
      en: `Pipeline done: ${steps.length} step(s) → ${current.length} file(s)`,
    },
  };
}

export function shouldFanOut(tool: ToolDescriptor, fileCount: number): boolean {
  return fileCount > 1 && tool.input.max === 1;
}

export function assertPipelineable(tool: ToolDescriptor, stepIndex: number): void {
  if (tool.pipelineable === false || tool.output === 'report') {
    throw new ToolError(
      'INVALID_PARAM',
      `Tool ${tool.id} cannot be used in a pipeline`,
      {
        zh: `「${tool.name.zh}」不能放进流水线（它不产生可串联的文件输出）。`,
        en: `"${tool.name.en}" cannot be used in a pipeline (it does not produce chainable files).`,
      },
      { toolId: tool.id, step: stepIndex },
    );
  }
}

/** Parse the JSON text the pipeline tool accepts as its `steps` param. */
export function parsePipelineSteps(raw: string): PipelineStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError('INVALID_PARAM', 'steps is not valid JSON', {
      zh: '步骤定义不是合法的 JSON。',
      en: 'The steps definition is not valid JSON.',
    });
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ToolError('INVALID_PARAM', 'steps must be a non-empty array', {
      zh: '步骤必须是非空数组。',
      en: 'Steps must be a non-empty array.',
    });
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ToolError('INVALID_PARAM', `steps[${index}] is not an object`, {
        zh: `步骤 ${index + 1} 格式错误。`,
        en: `Step ${index + 1} is malformed.`,
      });
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.toolId !== 'string' || record.toolId.trim() === '') {
      throw new ToolError('INVALID_PARAM', `steps[${index}].toolId missing`, {
        zh: `步骤 ${index + 1} 缺少 toolId。`,
        en: `Step ${index + 1} is missing toolId.`,
      });
    }
    const params =
      record.params && typeof record.params === 'object' && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : {};
    return { toolId: record.toolId.trim(), params };
  });
}

function asInputFile(file: { name: string; bytes: Uint8Array; mime: string }): ToolInputFile {
  return {
    name: file.name,
    bytes: file.bytes,
    mime: file.mime,
  };
}

function cloneFile(file: ToolInputFile): ToolInputFile {
  return {
    name: file.name,
    mime: file.mime,
    // Defensive copy so a later step cannot mutate a previous step's view.
    bytes: file.bytes.slice(),
  };
}
