import { selectPages } from '../../pdf/assemble.ts';
import { countPages } from '../../pdf/document.ts';
import { formatPageRange } from '../../pageRange.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  boolParam,
  pageRangeParam,
  passwordParam,
  pdfOutput,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

export const extractPagesTool: ToolDescriptor = {
  id: 'organize.extract-pages',
  category: 'organize',
  name: { zh: '提取页面', en: 'Extract Pages' },
  description: {
    zh: '把选中的页面单独抽出来，生成一个新的 PDF。',
    en: 'Pull the pages you select out into a new PDF of their own.',
  },
  icon: 'FileOutput',
  keywords: ['extract', 'select', 'pick', 'subset', '提取', '抽取', '选页'],
  input: PDF_ONE,
  output: 'single',
  params: [
    pageRangeParam({
      default: '1',
      help: {
        zh: '按填写的顺序提取，可以重复同一页。例如 3,1,1 会得到三页。',
        en: 'Pages come out in the order written, and may repeat — 3,1,1 yields three pages.',
      },
    }),
    {
      key: 'separate',
      type: 'boolean',
      label: { zh: '每页单独成文件', en: 'One file per page' },
      default: false,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const total = countPages(file.bytes, password);
    const pages = resolvePages(ctx, 'pages', total);

    if (boolParam(ctx, 'separate')) {
      const files = pages.map((page, index) => {
        const bytes = selectPages(file.bytes, password, [page], { garbage: 'compact' });
        ctx.report((index + 1) / pages.length);
        return pdfOutput(suffixedName(file.name, `_p${page}`, '.pdf'), bytes);
      });

      return {
        files,
        summary: {
          zh: `已提取第 ${formatPageRange(pages)} 页，共 ${files.length} 个文件`,
          en: `Extracted pages ${formatPageRange(pages)} into ${files.length} files`,
        },
      };
    }

    const bytes = selectPages(file.bytes, password, pages, { garbage: 'compact' });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(file.name, '_extracted', '.pdf'), bytes)],
      summary: {
        zh: `已提取第 ${formatPageRange(pages)} 页（共 ${pages.length} 页）`,
        en: `Extracted pages ${formatPageRange(pages)} — ${pages.length} in total`,
      },
    };
  },
};
