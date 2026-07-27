import { assemble } from '../../pdf/assemble.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { numberedName } from '../../naming.ts';
import { parsePageRange } from '../../pageRange.ts';
import { ToolError } from '../../errors.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  checkCancelled,
  numberParam,
  passwordParam,
  pdfOutput,
  reportStep,
  soleFile,
  stringParam,
} from '../shared.ts';

/** A contiguous run of 1-based page numbers that becomes one output file. */
export type Segment = number[];

/** `[1..total]` chopped into runs of `size`. */
export function splitEveryN(total: number, size: number): Segment[] {
  const segments: Segment[] = [];
  for (let start = 1; start <= total; start += size) {
    segments.push(rangeOf(start, Math.min(start + size - 1, total)));
  }
  return segments;
}

/**
 * Cuts *after* each of the given page numbers, which is how people describe it
 * ("split after page 3" keeps 1-3 together). Cut points at or past the last page
 * are ignored rather than producing an empty trailing file.
 */
export function splitAfterPages(total: number, cutAfter: readonly number[]): Segment[] {
  const cuts = [...new Set(cutAfter)].filter((p) => p >= 1 && p < total).sort((a, b) => a - b);

  const segments: Segment[] = [];
  let start = 1;
  for (const cut of cuts) {
    segments.push(rangeOf(start, cut));
    start = cut + 1;
  }
  segments.push(rangeOf(start, total));
  return segments;
}

/** Splits into `parts` files whose sizes differ by at most one page. */
export function splitIntoParts(total: number, parts: number): Segment[] {
  const count = Math.min(parts, total);
  const base = Math.floor(total / count);
  const remainder = total % count;

  const segments: Segment[] = [];
  let start = 1;
  for (let i = 0; i < count; i += 1) {
    const length = base + (i < remainder ? 1 : 0);
    segments.push(rangeOf(start, start + length - 1));
    start += length;
  }
  return segments;
}

/**
 * Greedily packs pages into files under `limitBytes`, using each page's own
 * serialised size as the estimate.
 *
 * The estimate is deliberately per-page rather than iterative: measuring the real
 * size after every added page would mean O(n²) full saves. Shared resources are
 * counted once per file, so a packed file lands at or under the limit in practice,
 * and a page larger than the limit becomes its own file rather than failing.
 */
export function packBySize(pageSizes: readonly number[], limitBytes: number): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = [];
  let currentBytes = 0;

  for (const [index, size] of pageSizes.entries()) {
    const page = index + 1;
    if (current.length > 0 && currentBytes + size > limitBytes) {
      segments.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(page);
    currentBytes += size;
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function rangeOf(from: number, to: number): Segment {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

export const splitTool: ToolDescriptor = {
  id: 'organize.split',
  category: 'organize',
  name: { zh: '拆分 PDF', en: 'Split PDF' },
  description: {
    zh: '把一个 PDF 拆成多个文件：按固定页数、指定切点、等份或文件大小。',
    en: 'Break one PDF into several files — by page count, cut points, equal parts or file size.',
  },
  icon: 'Scissors',
  keywords: ['split', 'divide', 'chunk', 'burst', '拆分', '分割', '分开'],
  input: PDF_ONE,
  output: 'multiple',
  params: [
    {
      key: 'mode',
      type: 'select',
      label: { zh: '拆分方式', en: 'Split by' },
      default: 'everyN',
      options: [
        { value: 'everyN', label: { zh: '每 N 页一个文件', en: 'Every N pages' } },
        { value: 'after', label: { zh: '在指定页后切开', en: 'After specific pages' } },
        { value: 'parts', label: { zh: '平均分成 N 份', en: 'Into N equal parts' } },
        { value: 'size', label: { zh: '按文件大小上限', en: 'By file size' } },
      ],
    },
    {
      key: 'everyN',
      type: 'number',
      label: { zh: '每个文件的页数', en: 'Pages per file' },
      default: 1,
      min: 1,
      max: 10000,
      integer: true,
      visibleWhen: { key: 'mode', equals: ['everyN'] },
    },
    {
      key: 'after',
      type: 'pageRange',
      label: { zh: '在这些页之后切开', en: 'Cut after these pages' },
      help: {
        zh: '例如填 3,7 会得到 1-3、4-7、8-末尾 三个文件。',
        en: 'e.g. 3,7 yields three files: 1-3, 4-7 and 8-end.',
      },
      default: '1',
      required: true,
      visibleWhen: { key: 'mode', equals: ['after'] },
    },
    {
      key: 'parts',
      type: 'number',
      label: { zh: '份数', en: 'Number of parts' },
      default: 2,
      min: 2,
      max: 1000,
      integer: true,
      visibleWhen: { key: 'mode', equals: ['parts'] },
    },
    {
      key: 'sizeLimitMb',
      type: 'number',
      label: { zh: '每个文件不超过', en: 'Maximum file size' },
      unit: { zh: 'MB', en: 'MB' },
      default: 10,
      min: 0.1,
      max: 2048,
      step: 0.1,
      visibleWhen: { key: 'mode', equals: ['size'] },
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const mode = stringParam(ctx, 'mode');

    const source = openDocument(file.bytes, password);
    try {
      const total = source.countPages();
      if (total < 2) {
        throw new ToolError('INVALID_INPUT', `Cannot split a ${total}-page document`, {
          zh: '这个文档只有 1 页，无法拆分。',
          en: 'This document has only one page, so there is nothing to split.',
        });
      }

      let segments: Segment[];
      switch (mode) {
        case 'after':
          segments = splitAfterPages(total, parsePageRange(stringParam(ctx, 'after'), total));
          break;
        case 'parts':
          segments = splitIntoParts(total, numberParam(ctx, 'parts'));
          break;
        case 'size': {
          const limit = Math.round(numberParam(ctx, 'sizeLimitMb') * 1024 * 1024);
          const pageSizes: number[] = [];
          for (let page = 1; page <= total; page += 1) {
            checkCancelled(ctx);
            const single = assemble([{ doc: source, pageIndex: page - 1 }]);
            try {
              pageSizes.push(saveDocument(single).length);
            } finally {
              single.destroy();
            }
            reportStep(ctx, page, total * 2, {
              zh: `正在估算第 ${page}/${total} 页大小`,
              en: `Measuring page ${page} of ${total}`,
            });
          }
          segments = packBySize(pageSizes, limit);
          break;
        }
        default:
          segments = splitEveryN(total, numberParam(ctx, 'everyN'));
      }

      const outputs = segments.map((segment, index) => {
        checkCancelled(ctx);
        const part = assemble(segment.map((page) => ({ doc: source, pageIndex: page - 1 })));
        try {
          const bytes = saveDocument(part, { garbage: 'compact' });
          reportStep(ctx, index + 1, segments.length, {
            zh: `正在写出第 ${index + 1}/${segments.length} 个文件`,
            en: `Writing file ${index + 1} of ${segments.length}`,
          });
          return pdfOutput(numberedName(file.name, index + 1, segments.length), bytes);
        } finally {
          part.destroy();
        }
      });

      ctx.report(1);
      return {
        files: outputs,
        summary: {
          zh: `已把 ${total} 页拆分为 ${outputs.length} 个文件`,
          en: `Split ${total} pages into ${outputs.length} files`,
        },
      };
    } finally {
      source.destroy();
    }
  },
};
