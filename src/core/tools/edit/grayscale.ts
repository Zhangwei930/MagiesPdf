import { PDFDocument } from 'pdf-lib';
import { openDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
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

/**
 * Rebuild each selected page as a grayscale raster embedded in a new PDF.
 *
 * Vector text becomes an image (searchable text is lost on those pages) — the
 * trade-off for a reliable grayscale conversion without rewriting content streams.
 * Only the selected pages are included in the output (like extract pages).
 */
export const grayscaleTool: ToolDescriptor = {
  id: 'edit.grayscale',
  category: 'edit',
  name: { zh: '转为灰度', en: 'Convert to Grayscale' },
  description: {
    zh: '把彩色页面转成灰度。选中的页会光栅化，文字不再可选中，适合打印或归档。',
    en: 'Convert colour pages to grayscale. Selected pages are rasterised — text is no longer selectable.',
  },
  icon: 'Image',
  keywords: ['grayscale', 'greyscale', 'black and white', 'mono', '灰度', '黑白', '去色'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'dpi',
      type: 'number',
      label: { zh: '渲染分辨率', en: 'Render resolution' },
      unit: { zh: 'DPI', en: 'DPI' },
      help: {
        zh: '150 适合屏幕，300 适合打印。越高文件越大。',
        en: '150 for screens, 300 for print. Higher means larger files.',
      },
      default: 150,
      min: 72,
      max: 300,
      integer: true,
    },
    {
      key: 'pages',
      type: 'pageRange',
      label: { zh: '页码范围', en: 'Pages' },
      default: 'all',
      required: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const dpi = numberParam(ctx, 'dpi');
    const password = stringParam(ctx, 'password');

    const source = openDocument(file.bytes, password);
    try {
      const pages = resolvePages(ctx, 'pages', source.countPages());
      const out = await PDFDocument.create();
      out.setProducer('MagiesPdf');

      for (let i = 0; i < pages.length; i += 1) {
        checkCancelled(ctx);
        const pageNumber = pages[i] as number;
        const pageIndex = pageNumber - 1;
        const bounds = source.loadPage(pageIndex).getBounds();
        const widthPt = bounds[2] - bounds[0];
        const heightPt = bounds[3] - bounds[1];

        const rendered = renderPage(source, pageIndex, {
          dpi,
          format: 'png',
          colorspace: 'gray',
        });
        const image = await out.embedPng(rendered.bytes);
        const page = out.addPage([widthPt, heightPt]);
        page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
        reportStep(ctx, i + 1, pages.length, {
          zh: `正在处理第 ${pageNumber} 页`,
          en: `Processing page ${pageNumber}`,
        });
      }

      const bytes = await out.save({ useObjectStreams: true });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_gray', '.pdf'), bytes)],
        summary: {
          zh: `已将 ${pages.length} 页转为灰度（${dpi} DPI）`,
          en: `Converted ${pages.length} page(s) to grayscale at ${dpi} DPI`,
        },
      };
    } finally {
      source.destroy();
    }
  },
};
