import { openDocument, saveDocument } from '../../pdf/document.ts';
import { placeTextOnPage, type Anchor } from '../../pdf/overlay.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  checkCancelled,
  numberParam,
  pageRangeParam,
  passwordParam,
  pdfOutput,
  reportStep,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

/** `{n}` is the page's number, `{total}` the count of numbered pages. */
export function formatPageLabel(template: string, n: number, total: number): string {
  return template.replaceAll('{n}', String(n)).replaceAll('{total}', String(total));
}

const FORMAT_TEMPLATES: Record<string, string> = {
  plain: '{n}',
  ofTotal: '{n} / {total}',
  dashed: '- {n} -',
  zh: '第 {n} 页，共 {total} 页',
};

export const addPageNumbersTool: ToolDescriptor = {
  id: 'edit.add-page-numbers',
  category: 'edit',
  name: { zh: '添加页码', en: 'Add Page Numbers' },
  description: {
    zh: '在页面边缘加上页码，位置、样式和起始数字都可调。',
    en: 'Number the pages along an edge — position, style and starting number are yours.',
  },
  icon: 'Hash',
  keywords: ['page number', 'numbering', 'folio', '页码', '编号'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'format',
      type: 'select',
      label: { zh: '页码样式', en: 'Style' },
      default: 'plain',
      options: [
        { value: 'plain', label: { zh: '1', en: '1' } },
        { value: 'ofTotal', label: { zh: '1 / 10', en: '1 / 10' } },
        { value: 'dashed', label: { zh: '- 1 -', en: '- 1 -' } },
        { value: 'zh', label: { zh: '第 1 页，共 10 页', en: '第 1 页，共 10 页' } },
        { value: 'custom', label: { zh: '自定义…', en: 'Custom…' } },
      ],
    },
    {
      key: 'template',
      type: 'text',
      label: { zh: '自定义模板', en: 'Custom template' },
      help: {
        zh: '{n} 是当前页码，{total} 是总页数。例如：Page {n} of {total}',
        en: '{n} is the page number, {total} the page count. e.g. Page {n} of {total}',
      },
      default: '{n}',
      required: true,
      visibleWhen: { key: 'format', equals: ['custom'] },
    },
    {
      key: 'position',
      type: 'select',
      label: { zh: '位置', en: 'Position' },
      default: 'bottom-center',
      options: [
        { value: 'bottom-center', label: { zh: '底部居中', en: 'Bottom centre' } },
        { value: 'bottom-right', label: { zh: '底部靠右', en: 'Bottom right' } },
        { value: 'bottom-left', label: { zh: '底部靠左', en: 'Bottom left' } },
        { value: 'top-center', label: { zh: '顶部居中', en: 'Top centre' } },
        { value: 'top-right', label: { zh: '顶部靠右', en: 'Top right' } },
        { value: 'top-left', label: { zh: '顶部靠左', en: 'Top left' } },
      ],
    },
    {
      key: 'startAt',
      type: 'number',
      label: { zh: '起始数字', en: 'Start at' },
      default: 1,
      min: 0,
      max: 999999,
      integer: true,
      advanced: true,
    },
    {
      key: 'size',
      type: 'number',
      label: { zh: '字号', en: 'Font size' },
      unit: { zh: '磅', en: 'pt' },
      default: 11,
      min: 6,
      max: 48,
      integer: true,
      advanced: true,
    },
    {
      key: 'color',
      type: 'color',
      label: { zh: '颜色', en: 'Colour' },
      default: '#444444',
      advanced: true,
    },
    pageRangeParam({
      label: { zh: '应用到哪些页', en: 'Apply to pages' },
      help: {
        zh: '未选中的页保持原样，也不参与编号。',
        en: 'Pages left out are untouched and not counted.',
      },
    }),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const format = stringParam(ctx, 'format');
    const template =
      format === 'custom' ? stringParam(ctx, 'template') : (FORMAT_TEMPLATES[format] ?? '{n}');
    const anchor = stringParam(ctx, 'position') as Anchor;
    const startAt = numberParam(ctx, 'startAt');
    const size = numberParam(ctx, 'size');
    const color = stringParam(ctx, 'color');

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const total = pages.length;

      for (const [index, page] of pages.entries()) {
        checkCancelled(ctx);
        placeTextOnPage(doc, page - 1, {
          text: formatPageLabel(template, startAt + index, startAt + total - 1),
          size,
          color,
          anchor,
          margin: 28,
        });
        reportStep(ctx, index + 1, pages.length + 1, {
          zh: `正在编号第 ${page} 页`,
          en: `Numbering page ${page}`,
        });
      }

      const bytes = saveDocument(doc, { garbage: 'compact' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_numbered', '.pdf'), bytes)],
        summary: {
          zh: `已为 ${pages.length} 页添加页码`,
          en: `Numbered ${pages.length} pages`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
