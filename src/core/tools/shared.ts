import { ToolError } from '../errors.ts';
import { parsePageRange } from '../pageRange.ts';
import { PDF_MIME } from '../pdf/document.ts';
import type {
  LocalizedText,
  PageRangeParam,
  PasswordParam,
  ToolContext,
  ToolInputFile,
  ToolInputSpec,
  ToolOutputFile,
} from '../types.ts';

/**
 * Boilerplate shared by tool descriptors. Fifty tools repeating the same input
 * spec and password field would drift; these keep them identical by construction.
 */

export const PDF_ONE: ToolInputSpec = { accept: ['.pdf'], min: 1, max: 1 };
export const PDF_MANY: ToolInputSpec = { accept: ['.pdf'], min: 2, max: null, ordered: true };
export const PDF_ANY: ToolInputSpec = { accept: ['.pdf'], min: 1, max: null, ordered: true };

/** The "this document is encrypted" field. Every PDF-reading tool should offer it. */
export function passwordParam(): PasswordParam {
  return {
    key: 'password',
    type: 'password',
    label: { zh: '文档密码', en: 'Document password' },
    help: {
      zh: '仅在源文件已加密时填写。批量处理时该密码会用于所有文件。',
      en: 'Only needed if the source file is encrypted. In batch runs it is tried on every file.',
    },
    default: '',
    advanced: true,
  };
}

export function pageRangeParam(overrides: Partial<PageRangeParam> = {}): PageRangeParam {
  return {
    key: 'pages',
    type: 'pageRange',
    label: { zh: '页码范围', en: 'Pages' },
    help: {
      zh: '例如 1,3,5 或 2-8 或 8- 或 1-10/2；也可用 all、odd、even、first、last、N（最后一页）。',
      en: 'e.g. 1,3,5 or 2-8 or 8- or 1-10/2. Keywords: all, odd, even, first, last, N (last page).',
    },
    default: 'all',
    required: true,
    ...overrides,
  };
}

export function pdfOutput(name: string, bytes: Uint8Array): ToolOutputFile {
  return { name, bytes, mime: PDF_MIME };
}

/** Reads a string param. Params are pre-validated, so this only narrows the type. */
export function stringParam(ctx: ToolContext, key: string): string {
  return String(ctx.params[key] ?? '');
}

export function numberParam(ctx: ToolContext, key: string): number {
  return Number(ctx.params[key] ?? 0);
}

export function boolParam(ctx: ToolContext, key: string): boolean {
  return ctx.params[key] === true;
}

export function listParam(ctx: ToolContext, key: string): string[] {
  const value = ctx.params[key];
  return Array.isArray(value) ? value : [];
}

/** Resolves a page-range param against the document's real page count. */
export function resolvePages(ctx: ToolContext, key: string, pageCount: number): number[] {
  return parsePageRange(stringParam(ctx, key), pageCount);
}

/** The single input file, for tools declaring `PDF_ONE`. */
export function soleFile(ctx: ToolContext): ToolInputFile {
  const file = ctx.files[0];
  if (!file) {
    throw new ToolError('INVALID_INPUT', 'Tool requires exactly one input file but got none', {
      zh: '请先选择一个文件。',
      en: 'Please choose a file first.',
    });
  }
  return file;
}

/** Throws if the job was cancelled; call between pages of a long loop. */
export function checkCancelled(ctx: ToolContext): void {
  if (ctx.signal.aborted) {
    throw new ToolError('CANCELLED', 'Job was cancelled', {
      zh: '任务已取消。',
      en: 'The job was cancelled.',
    });
  }
}

/** Reports progress as `done` of `total`, guarding against a zero total. */
export function reportStep(
  ctx: ToolContext,
  done: number,
  total: number,
  message?: LocalizedText,
): void {
  ctx.report(total > 0 ? Math.min(done / total, 1) : 1, message);
}
