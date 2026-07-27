import { withDocumentSync } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { numberedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  checkCancelled,
  numberParam,
  pageRangeParam,
  passwordParam,
  reportStep,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

export const pdfToImageTool: ToolDescriptor = {
  id: 'convert.pdf-to-image',
  category: 'convert',
  name: { zh: 'PDF 转图片', en: 'PDF to Images' },
  description: {
    zh: '把每一页渲染成 PNG 或 JPG 图片，可自定义分辨率。',
    en: 'Render each page as a PNG or JPG image, at the resolution you choose.',
  },
  icon: 'Image',
  keywords: ['image', 'png', 'jpg', 'jpeg', 'render', 'export', '图片', '转图', '导出'],
  input: PDF_ONE,
  output: 'multiple',
  params: [
    {
      key: 'format',
      type: 'select',
      label: { zh: '图片格式', en: 'Format' },
      default: 'png',
      options: [
        { value: 'png', label: { zh: 'PNG（无损）', en: 'PNG (lossless)' } },
        { value: 'jpeg', label: { zh: 'JPG（文件更小）', en: 'JPG (smaller files)' } },
      ],
    },
    {
      key: 'dpi',
      type: 'number',
      label: { zh: '分辨率', en: 'Resolution' },
      unit: { zh: 'DPI', en: 'DPI' },
      help: {
        zh: '150 适合屏幕阅读，300 适合打印。数值越高文件越大。',
        en: '150 suits screens, 300 suits print. Higher means bigger files.',
      },
      default: 150,
      min: 36,
      max: 600,
      integer: true,
    },
    {
      key: 'quality',
      type: 'number',
      label: { zh: 'JPG 质量', en: 'JPG quality' },
      default: 85,
      min: 1,
      max: 100,
      integer: true,
      visibleWhen: { key: 'format', equals: ['jpeg'] },
    },
    pageRangeParam({ label: { zh: '要转换的页', en: 'Pages to render' } }),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const format = stringParam(ctx, 'format') as 'png' | 'jpeg';
    const dpi = numberParam(ctx, 'dpi');
    const quality = numberParam(ctx, 'quality');

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const pages = resolvePages(ctx, 'pages', doc.countPages());

      const files = pages.map((page, index) => {
        checkCancelled(ctx);
        const rendered = renderPage(doc, page - 1, { dpi, format, quality });
        reportStep(ctx, index + 1, pages.length, {
          zh: `正在渲染第 ${page} 页（${index + 1}/${pages.length}）`,
          en: `Rendering page ${page} (${index + 1} of ${pages.length})`,
        });
        return {
          name: numberedName(file.name, page, pages.length, rendered.extension),
          bytes: rendered.bytes,
          mime: rendered.mime,
        };
      });

      return {
        files,
        summary: {
          zh: `已把 ${files.length} 页渲染为 ${format.toUpperCase()}（${dpi} DPI）`,
          en: `Rendered ${files.length} pages as ${format.toUpperCase()} at ${dpi} DPI`,
        },
      };
    });
  },
};
