import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { placeTextOnPage, type Anchor } from '../../pdf/overlay.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  checkCancelled,
  numberParam,
  passwordParam,
  pdfOutput,
  reportStep,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';
import { formatPageLabel } from './pageNumbers.ts';

/**
 * Stamp a header and/or footer line on each selected page.
 * Templates support `{n}` (page number) and `{total}` (page count in the range).
 */
export const addHeaderFooterTool: ToolDescriptor = {
  id: 'edit.add-header-footer',
  category: 'edit',
  name: { zh: '页眉页脚', en: 'Header & Footer' },
  description: {
    zh: '在页面顶部和/或底部加上文字，支持 {n}/{total} 页码占位。',
    en: 'Add text at the top and/or bottom of pages — {n} and {total} placeholders supported.',
  },
  icon: 'Hash',
  keywords: ['header', 'footer', 'running title', '页眉', '页脚', '页首', '页尾'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'header',
      type: 'text',
      label: { zh: '页眉', en: 'Header' },
      help: {
        zh: '留空则不画页眉。{n} 当前页，{total} 总页数。',
        en: 'Leave empty for none. {n} = page number, {total} = page count.',
      },
      default: '',
      maxLength: 200,
    },
    {
      key: 'footer',
      type: 'text',
      label: { zh: '页脚', en: 'Footer' },
      help: {
        zh: '留空则不画页脚。例如：第 {n} 页 / 共 {total} 页',
        en: 'Leave empty for none. e.g. Page {n} of {total}',
      },
      default: 'Page {n} of {total}',
      maxLength: 200,
    },
    {
      key: 'align',
      type: 'select',
      label: { zh: '对齐', en: 'Alignment' },
      default: 'center',
      options: [
        { value: 'left', label: { zh: '靠左', en: 'Left' } },
        { value: 'center', label: { zh: '居中', en: 'Centre' } },
        { value: 'right', label: { zh: '靠右', en: 'Right' } },
      ],
    },
    {
      key: 'size',
      type: 'number',
      label: { zh: '字号', en: 'Font size' },
      unit: { zh: '磅', en: 'pt' },
      default: 10,
      min: 6,
      max: 36,
      integer: true,
    },
    {
      key: 'color',
      type: 'color',
      label: { zh: '颜色', en: 'Colour' },
      default: '#444444',
    },
    {
      key: 'margin',
      type: 'number',
      label: { zh: '距页边', en: 'Margin from the edge' },
      unit: { zh: '磅', en: 'pt' },
      default: 28,
      min: 8,
      max: 120,
      advanced: true,
    },
    {
      key: 'startAt',
      type: 'number',
      label: { zh: '起始页码数字', en: 'Start numbering at' },
      default: 1,
      min: 0,
      max: 999999,
      integer: true,
      advanced: true,
    },
    {
      key: 'pages',
      type: 'pageRange',
      label: { zh: '应用范围', en: 'Pages' },
      default: 'all',
      required: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const header = stringParam(ctx, 'header');
    const footer = stringParam(ctx, 'footer');
    if (header.trim() === '' && footer.trim() === '') {
      throw new ToolError('INVALID_PARAM', 'header and footer are both empty', {
        zh: '请至少填写页眉或页脚之一。',
        en: 'Provide at least a header or a footer.',
      });
    }

    const align = stringParam(ctx, 'align');
    const size = numberParam(ctx, 'size');
    const color = stringParam(ctx, 'color') || '#444444';
    const margin = numberParam(ctx, 'margin');
    const startAt = numberParam(ctx, 'startAt');

    const headerAnchor = (`top-${align}` as Anchor);
    const footerAnchor = (`bottom-${align}` as Anchor);

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const total = pages.length;

      for (let i = 0; i < pages.length; i += 1) {
        checkCancelled(ctx);
        const pageNumber = pages[i] as number;
        const n = startAt + i;

        if (header.trim() !== '') {
          placeTextOnPage(doc, pageNumber - 1, {
            text: formatPageLabel(header, n, total),
            size,
            color,
            anchor: headerAnchor,
            margin,
          });
        }
        if (footer.trim() !== '') {
          placeTextOnPage(doc, pageNumber - 1, {
            text: formatPageLabel(footer, n, total),
            size,
            color,
            anchor: footerAnchor,
            margin,
          });
        }

        reportStep(ctx, i + 1, pages.length);
      }

      const bytes = saveDocument(doc);
      ctx.report(1);
      return {
        files: [pdfOutput(suffixedName(file.name, '_headed', '.pdf'), bytes)],
        summary: {
          zh: `已为 ${pages.length} 页添加页眉/页脚`,
          en: `Added header/footer on ${pages.length} page(s)`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
