import { assemble } from '../../pdf/assemble.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { stemOf, suffixedName } from '../../naming.ts';
import type { ToolDescriptor, ToolInputFile } from '../../types.ts';
import {
  PDF_MANY,
  boolParam,
  checkCancelled,
  passwordParam,
  pdfOutput,
  reportStep,
  stringParam,
} from '../shared.ts';

/** Natural ordering, so `chapter2.pdf` sorts before `chapter10.pdf`. */
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortFiles(files: readonly ToolInputFile[], order: string): ToolInputFile[] {
  const sorted = [...files];
  switch (order) {
    case 'nameAsc':
      return sorted.sort((a, b) => NATURAL.compare(a.name, b.name));
    case 'nameDesc':
      return sorted.sort((a, b) => NATURAL.compare(b.name, a.name));
    case 'sizeAsc':
      return sorted.sort((a, b) => a.bytes.length - b.bytes.length);
    default:
      // "asIs" — respects the drag-to-reorder order the user set in the UI.
      return sorted;
  }
}

/** `a.pdf` + `b.pdf` → `a_merged.pdf`; more than two sources just use the first. */
function mergedName(files: readonly ToolInputFile[]): string {
  const first = files[0];
  return suffixedName(first ? first.name : 'merged.pdf', '_merged', '.pdf');
}

export const mergeTool: ToolDescriptor = {
  id: 'organize.merge',
  category: 'organize',
  name: { zh: '合并 PDF', en: 'Merge PDF' },
  description: {
    zh: '把多个 PDF 按指定顺序合并成一个文件。',
    en: 'Combine several PDFs into a single file, in the order you choose.',
  },
  icon: 'Combine',
  keywords: ['merge', 'combine', 'join', 'concat', '合并', '拼接', '组合'],
  input: PDF_MANY,
  output: 'single',
  params: [
    {
      key: 'order',
      type: 'select',
      label: { zh: '合并顺序', en: 'Order' },
      default: 'asIs',
      options: [
        { value: 'asIs', label: { zh: '按列表顺序（可拖动调整）', en: 'As listed (drag to reorder)' } },
        { value: 'nameAsc', label: { zh: '按文件名升序', en: 'File name, A → Z' } },
        { value: 'nameDesc', label: { zh: '按文件名降序', en: 'File name, Z → A' } },
        { value: 'sizeAsc', label: { zh: '按文件大小升序', en: 'File size, small → large' } },
      ],
    },
    passwordParam(),
    {
      key: 'compress',
      type: 'boolean',
      label: { zh: '合并后清理冗余对象', en: 'Clean up redundant objects' },
      help: {
        zh: '删除重复的字体和资源，文件更小，但处理更慢。',
        en: 'Drops duplicated fonts and resources for a smaller file, at the cost of speed.',
      },
      default: true,
      advanced: true,
    },
  ],
  runtime: 'worker',

  async run(ctx) {
    const order = stringParam(ctx, 'order');
    const password = stringParam(ctx, 'password');
    const files = sortFiles(ctx.files, order);

    // Sources stay open until the graft is done: MuPDF reads from them lazily.
    const opened = [];
    try {
      for (const [index, file] of files.entries()) {
        checkCancelled(ctx);
        opened.push({ file, doc: openDocument(file.bytes, password) });
        reportStep(ctx, index + 1, files.length + 1, {
          zh: `正在读取 ${file.name}`,
          en: `Reading ${file.name}`,
        });
      }

      const refs = opened.flatMap(({ doc }) =>
        Array.from({ length: doc.countPages() }, (_, pageIndex) => ({ doc, pageIndex })),
      );

      const merged = assemble(refs);
      try {
        const bytes = saveDocument(merged, {
          garbage: boolParam(ctx, 'compress') ? 'deduplicate' : 'compact',
        });
        ctx.report(1);

        return {
          files: [pdfOutput(mergedName(files), bytes)],
          summary: {
            zh: `已把 ${files.length} 个文件的 ${refs.length} 页合并为 ${stemOf(mergedName(files))}`,
            en: `Merged ${refs.length} pages from ${files.length} files`,
          },
        };
      } finally {
        merged.destroy();
      }
    } finally {
      for (const { doc } of opened) doc.destroy();
    }
  },
};
