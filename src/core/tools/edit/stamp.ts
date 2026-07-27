import { PDFDocument } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { decryptToBytes } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { sniffImage } from '../convert/imageToPdf.ts';
import {
  checkCancelled,
  numberParam,
  passwordParam,
  pdfOutput,
  reportStep,
  resolvePages,
  stringParam,
} from '../shared.ts';

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

export const addStampTool: ToolDescriptor = {
  id: 'edit.add-stamp',
  category: 'edit',
  name: { zh: '添加图章', en: 'Add Image Stamp' },
  description: {
    zh: '把 PNG/JPG 图片（公司章、签名图、Logo）盖到页面上。第一个文件是 PDF，第二个是图片。',
    en: 'Stamp a PNG/JPG — a seal, a signature image, a logo — onto pages. First file is the PDF, second the image.',
  },
  icon: 'Stamp',
  keywords: ['stamp', 'seal', 'logo', 'signature image', 'chop', '图章', '盖章', '公章', '签名图'],
  input: { accept: ['.pdf', '.png', '.jpg', '.jpeg'], min: 2, max: 2, ordered: true },
  output: 'single',
  params: [
    {
      key: 'position',
      type: 'select',
      label: { zh: '位置', en: 'Position' },
      default: 'bottom-right',
      options: [
        { value: 'bottom-right', label: { zh: '右下', en: 'Bottom right' } },
        { value: 'bottom-left', label: { zh: '左下', en: 'Bottom left' } },
        { value: 'top-right', label: { zh: '右上', en: 'Top right' } },
        { value: 'top-left', label: { zh: '左上', en: 'Top left' } },
        { value: 'center', label: { zh: '正中', en: 'Centre' } },
      ],
    },
    {
      key: 'widthPercent',
      type: 'number',
      label: { zh: '图章宽度（占页宽）', en: 'Stamp width (of page width)' },
      unit: { zh: '%', en: '%' },
      default: 25,
      min: 3,
      max: 100,
    },
    {
      key: 'opacity',
      type: 'number',
      label: { zh: '不透明度', en: 'Opacity' },
      default: 1,
      min: 0.1,
      max: 1,
      step: 0.05,
    },
    {
      key: 'margin',
      type: 'number',
      label: { zh: '距页边', en: 'Margin from the edge' },
      unit: { zh: '磅', en: 'pt' },
      default: 36,
      min: 0,
      max: 300,
      advanced: true,
    },
    pageRange(),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const [pdfFile, imageFile] = ctx.files;
    if (!pdfFile || !pdfFile.name.toLowerCase().endsWith('.pdf') || !imageFile) {
      throw new ToolError('INVALID_INPUT', 'Expected a PDF then an image', {
        zh: '需要两个文件：第一个是 PDF，第二个是 PNG/JPG 图片。',
        en: 'Two files are needed: the PDF first, then a PNG/JPG image.',
      });
    }

    const kind = sniffImage(imageFile.bytes);
    if (!kind) {
      throw new ToolError('UNSUPPORTED_FORMAT', `"${imageFile.name}" is not a PNG or JPEG`, {
        zh: `「${imageFile.name}」不是有效的 PNG 或 JPG 图片。`,
        en: `"${imageFile.name}" is not a valid PNG or JPG image.`,
      });
    }

    const doc = await PDFDocument.load(
      decryptToBytes(pdfFile.bytes, stringParam(ctx, 'password')),
      { updateMetadata: false },
    );
    const image =
      kind === 'png' ? await doc.embedPng(imageFile.bytes) : await doc.embedJpg(imageFile.bytes);

    const position = stringParam(ctx, 'position') as Corner;
    const widthPercent = numberParam(ctx, 'widthPercent') / 100;
    const opacity = numberParam(ctx, 'opacity');
    const margin = numberParam(ctx, 'margin');
    const targets = resolvePages(ctx, 'pages', doc.getPageCount());

    for (const [index, pageNumber] of targets.entries()) {
      checkCancelled(ctx);
      const page = doc.getPage(pageNumber - 1);
      const { width: pageWidth, height: pageHeight } = page.getSize();

      const drawWidth = pageWidth * widthPercent;
      const drawHeight = drawWidth * (image.height / image.width);

      let x: number;
      let y: number;
      if (position === 'center') {
        x = (pageWidth - drawWidth) / 2;
        y = (pageHeight - drawHeight) / 2;
      } else {
        x = position.endsWith('left') ? margin : pageWidth - margin - drawWidth;
        y = position.startsWith('bottom') ? margin : pageHeight - margin - drawHeight;
      }

      page.drawImage(image, { x, y, width: drawWidth, height: drawHeight, opacity });
      reportStep(ctx, index + 1, targets.length, {
        zh: `正在盖章第 ${pageNumber} 页`,
        en: `Stamping page ${pageNumber}`,
      });
    }

    const bytes = await doc.save({ useObjectStreams: true });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(pdfFile.name, '_stamped', '.pdf'), bytes)],
      summary: {
        zh: `已在 ${targets.length} 页盖上「${imageFile.name}」`,
        en: `Stamped "${imageFile.name}" onto ${targets.length} pages`,
      },
    };
  },
};

function pageRange() {
  return {
    key: 'pages',
    type: 'pageRange' as const,
    label: { zh: '盖到哪些页', en: 'Pages to stamp' },
    default: 'all',
    required: true,
  };
}
