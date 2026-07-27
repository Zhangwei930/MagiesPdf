import { ToolError } from '../../errors.ts';
import { selectPages } from '../../pdf/assemble.ts';
import { countPages } from '../../pdf/document.ts';
import { formatPageRange } from '../../pageRange.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  pageRangeParam,
  passwordParam,
  pdfOutput,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

export const removePagesTool: ToolDescriptor = {
  id: 'organize.remove-pages',
  category: 'organize',
  name: { zh: '删除页面', en: 'Remove Pages' },
  description: {
    zh: '从 PDF 中删掉选中的页面，其余页面顺序保持不变。',
    en: 'Delete the pages you select; everything else keeps its order.',
  },
  icon: 'FileMinus',
  keywords: ['remove', 'delete', 'drop', 'discard', '删除', '删页', '去掉'],
  input: PDF_ONE,
  output: 'single',
  params: [
    pageRangeParam({
      label: { zh: '要删除的页', en: 'Pages to remove' },
      default: '1',
    }),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const total = countPages(file.bytes, password);

    const doomed = new Set(resolvePages(ctx, 'pages', total));
    const kept = Array.from({ length: total }, (_, i) => i + 1).filter((p) => !doomed.has(p));

    if (kept.length === 0) {
      throw new ToolError('EMPTY_RESULT', 'Removing those pages would empty the document', {
        zh: `这样会删掉全部 ${total} 页，文档将为空。请少选一些页面。`,
        en: `That removes all ${total} pages, leaving nothing. Select fewer pages.`,
      });
    }

    const bytes = selectPages(file.bytes, password, kept, { garbage: 'compact' });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(file.name, '_trimmed', '.pdf'), bytes)],
      summary: {
        zh: `已删除第 ${formatPageRange([...doomed])} 页，剩余 ${kept.length} 页`,
        en: `Removed pages ${formatPageRange([...doomed])}; ${kept.length} pages remain`,
      },
    };
  },
};
