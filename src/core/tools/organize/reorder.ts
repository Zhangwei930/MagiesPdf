import { selectPages } from '../../pdf/assemble.ts';
import { countPages } from '../../pdf/document.ts';
import { applyPreset, type OrderPreset } from '../../pdf/pageOrders.ts';
import { parsePageRange } from '../../pageRange.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

export const reorderTool: ToolDescriptor = {
  id: 'organize.reorder',
  category: 'organize',
  name: { zh: '重排页面', en: 'Reorder Pages' },
  description: {
    zh: '按自定义顺序或常用预设重排页面：倒序、奇偶分离、双面扫描修正、小册子排版。',
    en: 'Rearrange pages by hand or with a preset — reverse, odd/even, duplex-scan repair, booklet.',
  },
  icon: 'ArrowUpDown',
  keywords: ['reorder', 'rearrange', 'sort', 'reverse', 'booklet', 'duplex', '重排', '排序', '倒序', '小册子'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'preset',
      type: 'select',
      label: { zh: '排列方式', en: 'Arrangement' },
      default: 'custom',
      options: [
        { value: 'custom', label: { zh: '自定义顺序', en: 'Custom order' } },
        { value: 'reverse', label: { zh: '倒序', en: 'Reverse' } },
        {
          value: 'oddEvenSplit',
          label: { zh: '奇偶分离（先全部奇数页）', en: 'Odd/even split (all odd pages first)' },
        },
        {
          value: 'oddEvenMerge',
          label: { zh: '奇偶合并（修正正反面分开扫描）', en: 'Odd/even merge (fixes fronts-then-backs scans)' },
        },
        {
          value: 'duplexSort',
          label: { zh: '双面扫描修正（背面倒序）', en: 'Duplex repair (backs fed in reverse)' },
        },
        { value: 'booklet', label: { zh: '小册子排版顺序', en: 'Booklet imposition order' } },
      ],
    },
    {
      key: 'order',
      type: 'pageRange',
      label: { zh: '页码顺序', en: 'Page order' },
      help: {
        zh: '按想要的先后填写，例如 3,1,2 或 5-1。未列出的页会被丢弃。',
        en: 'List pages in the order you want, e.g. 3,1,2 or 5-1. Pages left out are dropped.',
      },
      default: 'all',
      required: true,
      visibleWhen: { key: 'preset', equals: ['custom'] },
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const preset = stringParam(ctx, 'preset') as OrderPreset;
    const total = countPages(file.bytes, password);

    const order =
      preset === 'custom'
        ? parsePageRange(stringParam(ctx, 'order'), total)
        : applyPreset(preset, total);

    const bytes = selectPages(file.bytes, password, order, { garbage: 'compact' });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(file.name, '_reordered', '.pdf'), bytes)],
      summary: {
        zh: `已按${preset === 'custom' ? '自定义顺序' : '预设'}重排 ${order.length} 页`,
        en: `Reordered ${order.length} pages`,
      },
    };
  },
};
