import { ToolError } from '../../errors.ts';
import { PDFDocument } from 'pdf-lib';
import { decryptToBytes } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  checkCancelled,
  passwordParam,
  pdfOutput,
  reportStep,
  resolvePages,
  stringParam,
} from '../shared.ts';

export const overlayPdfTool: ToolDescriptor = {
  id: 'organize.overlay',
  category: 'organize',
  name: { zh: '叠加 PDF', en: 'Overlay PDFs' },
  description: {
    zh: '把第二个 PDF 盖在第一个上面——信头纸、模板、格线都用这一招。',
    en: 'Lay a second PDF over the first — letterheads, templates and grids all work this way.',
  },
  icon: 'Layers',
  keywords: ['overlay', 'stamp', 'letterhead', 'template', 'background', '叠加', '信头', '模板', '套打'],
  input: { accept: ['.pdf'], min: 2, max: 2, ordered: true },
  output: 'single',
  params: [
    {
      key: 'sequence',
      type: 'select',
      label: { zh: '叠加层用法', en: 'Overlay usage' },
      default: 'repeatFirst',
      options: [
        {
          value: 'repeatFirst',
          label: { zh: '第 1 页重复盖到每一页', en: 'Repeat its first page onto every page' },
        },
        {
          value: 'cycle',
          label: { zh: '按页循环（1对1、2对2…用完从头再来）', en: 'Cycle its pages (1→1, 2→2, … wrapping around)' },
        },
      ],
    },
    {
      key: 'fit',
      type: 'select',
      label: { zh: '尺寸适配', en: 'Sizing' },
      default: 'stretch',
      options: [
        { value: 'stretch', label: { zh: '拉伸铺满页面', en: 'Stretch to fill the page' } },
        { value: 'fit', label: { zh: '等比缩放居中', en: 'Scale proportionally, centred' } },
      ],
    },
    resolveOnPages(),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const [main, overlay] = ctx.files;
    if (!main || !overlay) {
      throw new ToolError('INVALID_INPUT', 'Overlay needs exactly two files', {
        zh: '需要两个文件：第一个是主文件，第二个是叠加层。',
        en: 'Two files are needed: the base document first, the overlay second.',
      });
    }

    const password = stringParam(ctx, 'password');
    const doc = await PDFDocument.load(decryptToBytes(main.bytes, password), {
      updateMetadata: false,
    });

    const overlayPlain = decryptToBytes(overlay.bytes, password);
    const overlayCount = (await PDFDocument.load(overlayPlain, { updateMetadata: false })).getPageCount();
    const cycle = stringParam(ctx, 'sequence') === 'cycle';
    const embedded = await doc.embedPdf(
      overlayPlain,
      cycle ? [...Array(overlayCount).keys()] : [0],
    );

    const stretch = stringParam(ctx, 'fit') === 'stretch';
    const targets = resolvePages(ctx, 'pages', doc.getPageCount());

    for (const [index, pageNumber] of targets.entries()) {
      checkCancelled(ctx);
      const page = doc.getPage(pageNumber - 1);
      const stamp = embedded[cycle ? index % embedded.length : 0];
      if (!stamp) break;

      const { width, height } = page.getSize();
      if (stretch) {
        page.drawPage(stamp, {
          x: 0,
          y: 0,
          xScale: width / stamp.width,
          yScale: height / stamp.height,
        });
      } else {
        const scale = Math.min(width / stamp.width, height / stamp.height);
        page.drawPage(stamp, {
          x: (width - stamp.width * scale) / 2,
          y: (height - stamp.height * scale) / 2,
          xScale: scale,
          yScale: scale,
        });
      }

      reportStep(ctx, index + 1, targets.length, {
        zh: `正在叠加第 ${pageNumber} 页`,
        en: `Overlaying page ${pageNumber}`,
      });
    }

    const bytes = await doc.save({ useObjectStreams: true });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(main.name, '_overlaid', '.pdf'), bytes)],
      summary: {
        zh: `已把「${overlay.name}」叠加到 ${targets.length} 页上`,
        en: `Overlaid "${overlay.name}" onto ${targets.length} pages`,
      },
    };
  },
};

function resolveOnPages() {
  return {
    key: 'pages',
    type: 'pageRange' as const,
    label: { zh: '叠加到主文件的哪些页', en: 'Pages of the base document' },
    default: 'all',
    required: true,
  };
}
