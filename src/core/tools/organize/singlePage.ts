import { PDFDocument } from 'pdf-lib';
import { decryptToBytes } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  numberParam,
  passwordParam,
  pdfOutput,
  soleFile,
  stringParam,
} from '../shared.ts';

export const singlePageTool: ToolDescriptor = {
  id: 'organize.single-page',
  category: 'organize',
  name: { zh: '合成长页', en: 'One Long Page' },
  description: {
    zh: '把所有页面竖着接成一整页，像长截图一样连续滚动阅读。',
    en: 'Stack every page into one tall continuous page — reads like a long screenshot.',
  },
  icon: 'GalleryVertical',
  keywords: ['long', 'continuous', 'scroll', 'stitch', '长图', '长页', '拼接', '滚动'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'gap',
      type: 'number',
      label: { zh: '页间距', en: 'Gap between pages' },
      unit: { zh: '磅', en: 'pt' },
      help: {
        zh: '注意：部分老阅读器对超过 14400 磅（约 200 页 A4）的超长页面支持不佳。',
        en: 'Note: some older viewers struggle past 14,400 pt (roughly 200 A4 pages).',
      },
      default: 0,
      min: 0,
      max: 144,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const gap = numberParam(ctx, 'gap');

    const plain = decryptToBytes(file.bytes, stringParam(ctx, 'password'));
    const source = await PDFDocument.load(plain, { updateMetadata: false });
    const pageCount = source.getPageCount();

    const out = await PDFDocument.create();
    out.setProducer('MagiesPdf');
    const embedded = await out.embedPdf(plain, [...Array(pageCount).keys()]);

    const width = Math.max(...embedded.map((page) => page.width));
    const height =
      embedded.reduce((sum, page) => sum + page.height, 0) + gap * (embedded.length - 1);

    const tall = out.addPage([width, height]);
    let cursor = height;
    for (const page of embedded) {
      cursor -= page.height;
      tall.drawPage(page, { x: (width - page.width) / 2, y: cursor });
      cursor -= gap;
    }

    const bytes = await out.save({ useObjectStreams: true });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(file.name, '_long', '.pdf'), bytes)],
      summary: {
        zh: `已把 ${pageCount} 页接成一页（高 ${Math.round(height)} 磅）`,
        en: `Stitched ${pageCount} pages into one (${Math.round(height)} pt tall)`,
      },
    };
  },
};
