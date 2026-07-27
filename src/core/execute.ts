import { ToolError, toToolError } from './errors.ts';
import { extensionOf } from './naming.ts';
import { validateParams } from './params.ts';
import type {
  HostBridge,
  LocalizedText,
  ToolDescriptor,
  ToolInputFile,
  ToolResult,
} from './types.ts';

/**
 * The one path a tool is ever invoked through — used by the worker pool, the
 * REST API, the pipeline runner and the tests alike. Input and parameter
 * validation live here so no tool has to repeat them, and so an invalid request
 * fails identically no matter which entry point it arrived from.
 */

export interface ExecuteOptions {
  files: readonly ToolInputFile[];
  params: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  host?: HostBridge;
  onProgress?: (fraction: number, message?: LocalizedText) => void;
}

function plural(n: number, zh: string, en: string): LocalizedText {
  return { zh: `${n} ${zh}`, en: `${n} ${en}${n === 1 ? '' : 's'}` };
}

function validateFiles(tool: ToolDescriptor, files: readonly ToolInputFile[]): void {
  const { min, max, accept } = tool.input;

  if (files.length < min) {
    throw new ToolError(
      'INVALID_INPUT',
      `${tool.id} needs at least ${min} file(s), got ${files.length}`,
      {
        zh: `「${tool.name.zh}」至少需要 ${min} 个文件，当前只有 ${files.length} 个。`,
        en: `"${tool.name.en}" needs at least ${plural(min, '个文件', 'file').en}, but got ${files.length}.`,
      },
      { min, actual: files.length },
    );
  }

  if (max !== null && files.length > max) {
    throw new ToolError(
      'INVALID_INPUT',
      `${tool.id} accepts at most ${max} file(s), got ${files.length}`,
      {
        zh: `「${tool.name.zh}」最多接受 ${max} 个文件，当前有 ${files.length} 个。`,
        en: `"${tool.name.en}" accepts at most ${max} file(s), but got ${files.length}.`,
      },
      { max, actual: files.length },
    );
  }

  for (const file of files) {
    const extension = extensionOf(file.name);
    // Generators (min/max 0) declare an empty accept list and never receive files.
    if (accept.length > 0 && !accept.includes(extension)) {
      throw new ToolError(
        'UNSUPPORTED_FORMAT',
        `${tool.id} does not accept "${extension || 'no extension'}" (${file.name})`,
        {
          zh: `「${tool.name.zh}」不支持 ${extension || '无扩展名'} 文件：${file.name}。支持的格式：${accept.join('、')}`,
          en: `"${tool.name.en}" does not support ${extension || 'extensionless'} files (${file.name}). Supported: ${accept.join(', ')}`,
        },
        { file: file.name, extension, accept },
      );
    }

    if (file.bytes.length === 0) {
      throw new ToolError('INVALID_INPUT', `File "${file.name}" is empty`, {
        zh: `文件「${file.name}」是空的。`,
        en: `The file "${file.name}" is empty.`,
      });
    }
  }
}

export async function executeTool(
  tool: ToolDescriptor,
  options: ExecuteOptions,
): Promise<ToolResult> {
  const { files, params, host, onProgress } = options;
  const signal = options.signal ?? new AbortController().signal;

  validateFiles(tool, files);
  const validated = validateParams(tool.params, params);

  if (tool.runtime === 'main' && !host) {
    throw new ToolError('HOST_UNAVAILABLE', `${tool.id} requires the main-process host bridge`, {
      zh: `「${tool.name.zh}」需要应用主进程能力，无法在当前环境运行。`,
      en: `"${tool.name.en}" needs main-process capabilities and cannot run here.`,
    });
  }

  if (signal.aborted) {
    throw new ToolError('CANCELLED', 'Job was cancelled before it started', {
      zh: '任务已取消。',
      en: 'The job was cancelled.',
    });
  }

  try {
    const result = await tool.run({
      files: [...files],
      params: validated,
      signal,
      report: (fraction, message) => onProgress?.(Math.max(0, Math.min(fraction, 1)), message),
      host,
    });

    if (tool.output !== 'report' && result.files.length === 0) {
      throw new ToolError('EMPTY_RESULT', `${tool.id} produced no output files`, {
        zh: '这次处理没有产生任何输出，请检查参数设置。',
        en: 'That run produced no output. Check the options and try again.',
      });
    }

    return result;
  } catch (cause) {
    throw toToolError(cause);
  }
}
