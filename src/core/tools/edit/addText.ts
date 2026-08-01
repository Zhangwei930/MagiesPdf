import * as mupdf from 'mupdf';
import { ToolError } from '../../errors.ts';
import { suffixedName } from '../../naming.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { placeTextAtPoint } from '../../pdf/overlay.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  numberParam,
  passwordParam,
  pdfOutput,
  soleFile,
  stringParam,
} from '../shared.ts';

export const addTextTool: ToolDescriptor = {
  id: 'edit.add-text',
  category: 'edit',
  name: { zh: '直接添加文字', en: 'Add Text Directly' },
  description: {
    zh: '在 PDF 页面点击的位置直接输入文字。',
    en: 'Type text directly at a chosen point on a PDF page.',
  },
  icon: 'PenLine',
  keywords: ['text', 'type', 'edit', '文字', '输入', '直接编辑'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'text',
      type: 'text',
      label: { zh: '文字', en: 'Text' },
      default: '',
      required: true,
      maxLength: 500,
    },
    { key: 'page', type: 'number', label: { zh: '页码', en: 'Page' }, default: 1, min: 1, integer: true },
    { key: 'x', type: 'number', label: { zh: '横坐标', en: 'X position' }, default: 72, min: 0, advanced: true },
    { key: 'y', type: 'number', label: { zh: '纵坐标', en: 'Y position' }, default: 72, min: 0, advanced: true },
    { key: 'size', type: 'number', label: { zh: '字号', en: 'Font size' }, default: 14, min: 6, max: 96 },
    { key: 'color', type: 'color', label: { zh: '颜色', en: 'Colour' }, default: '#111111' },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const text = stringParam(ctx, 'text');
    if (text.trim() === '') {
      throw new ToolError('INVALID_PARAM', 'text is empty', {
        zh: '请输入要添加的文字。',
        en: 'Enter the text to add.',
      });
    }

    const pageNumber = Math.floor(numberParam(ctx, 'page'));
    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      if (pageNumber < 1 || pageNumber > doc.countPages()) {
        throw new ToolError('INVALID_PARAM', 'page is outside the document', {
          zh: '页码超出文档范围。',
          en: 'The page is outside the document.',
        });
      }

      const page = doc.loadPage(pageNumber - 1);
      const [x0, y0, x1, y1] = page.getBounds();
      const x = numberParam(ctx, 'x');
      const y = numberParam(ctx, 'y');
      if (x < x0 || x > x1 || y < y0 || y > y1) {
        throw new ToolError('INVALID_PARAM', 'text point is outside the page', {
          zh: '文字位置超出页面范围。',
          en: 'The text position is outside the page.',
        });
      }

      // Viewer clicks arrive in displayed page space: top-left origin with
      // `/Rotate` already applied. Content streams use raw PDF coordinates.
      // MuPDF exposes that page transform, so its inverse handles rotation,
      // crop offsets and the y-axis flip without guessing from page metadata.
      const displayToPdf = mupdf.Matrix.invert(page.getTransform());
      const pdfX = x * displayToPdf[0] + y * displayToPdf[2] + displayToPdf[4];
      const pdfY = x * displayToPdf[1] + y * displayToPdf[3] + displayToPdf[5];

      placeTextAtPoint(doc, pageNumber - 1, {
        text,
        matrix: [
          displayToPdf[0],
          displayToPdf[1],
          -displayToPdf[2],
          -displayToPdf[3],
          pdfX,
          pdfY,
        ],
        size: numberParam(ctx, 'size'),
        color: stringParam(ctx, 'color') || '#111111',
      });

      const bytes = saveDocument(doc);
      ctx.report(1);
      return {
        files: [pdfOutput(suffixedName(file.name, '_edited', '.pdf'), bytes)],
        summary: {
          zh: `已在第 ${pageNumber} 页添加文字`,
          en: `Added text to page ${pageNumber}`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
