import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ToolDescriptor } from '../../types.ts';
import { numberParam, pdfOutput, stringParam } from '../shared.ts';

const SIZES: Record<string, [number, number]> = {
  a4: [595.28, 841.89],
  a4Landscape: [841.89, 595.28],
  letter: [612, 792],
  letterLandscape: [792, 612],
  a3: [841.89, 1190.55],
  a5: [419.53, 595.28],
};

/**
 * Create an empty multi-page PDF — useful as a pipeline seed, a booklet shell,
 * or a placeholder before stamping/signing.
 */
export const createBlankTool: ToolDescriptor = {
  id: 'edit.create-blank',
  category: 'edit',
  name: { zh: '新建空白 PDF', en: 'Create Blank PDF' },
  description: {
    zh: '生成指定页数、纸型的空白 PDF，可选在每页打上页码占位。',
    en: 'Generate a blank PDF with a chosen page count and paper size; optional page labels.',
  },
  icon: 'FileText',
  keywords: ['blank', 'empty', 'new', 'create', '空白', '新建', '空文档'],
  /** Generator tools take no input files. */
  input: { accept: [], min: 0, max: 0 },
  output: 'single',
  params: [
    {
      key: 'pages',
      type: 'number',
      label: { zh: '页数', en: 'Pages' },
      default: 1,
      min: 1,
      max: 500,
      integer: true,
    },
    {
      key: 'pageSize',
      type: 'select',
      label: { zh: '纸型', en: 'Page size' },
      default: 'a4',
      options: [
        { value: 'a4', label: { zh: 'A4 纵向', en: 'A4 portrait' } },
        { value: 'a4Landscape', label: { zh: 'A4 横向', en: 'A4 landscape' } },
        { value: 'letter', label: { zh: 'Letter 纵向', en: 'Letter portrait' } },
        { value: 'letterLandscape', label: { zh: 'Letter 横向', en: 'Letter landscape' } },
        { value: 'a3', label: { zh: 'A3', en: 'A3' } },
        { value: 'a5', label: { zh: 'A5', en: 'A5' } },
      ],
    },
    {
      key: 'labelPages',
      type: 'boolean',
      label: { zh: '在页面中央显示页码', en: 'Show page number in the centre' },
      default: false,
    },
    {
      key: 'fileName',
      type: 'text',
      label: { zh: '文件名', en: 'File name' },
      default: 'blank.pdf',
      advanced: true,
    },
  ],
  runtime: 'worker',
  pipelineable: true,

  async run(ctx) {
    const pageCount = Math.max(1, Math.min(500, Math.floor(numberParam(ctx, 'pages') || 1)));
    const sizeKey = stringParam(ctx, 'pageSize') || 'a4';
    const size = SIZES[sizeKey] ?? SIZES.a4!;
    const labelPages = ctx.params.labelPages === true;
    let fileName = stringParam(ctx, 'fileName').trim() || 'blank.pdf';
    if (!fileName.toLowerCase().endsWith('.pdf')) fileName = `${fileName}.pdf`;

    const doc = await PDFDocument.create();
    doc.setTitle('Blank document');
    doc.setProducer('MagiesPdf');
    const font = labelPages ? await doc.embedFont(StandardFonts.Helvetica) : null;

    for (let i = 1; i <= pageCount; i += 1) {
      const page = doc.addPage(size);
      if (font && labelPages) {
        const text = String(i);
        const fontSize = 14;
        const textWidth = font.widthOfTextAtSize(text, fontSize);
        page.drawText(text, {
          x: (size[0] - textWidth) / 2,
          y: size[1] / 2,
          size: fontSize,
          font,
          color: rgb(0.7, 0.7, 0.7),
        });
      }
    }

    const bytes = await doc.save({ useObjectStreams: false });
    ctx.report(1);

    return {
      files: [pdfOutput(fileName, bytes)],
      summary: {
        zh: `已创建 ${pageCount} 页空白 PDF`,
        en: `Created a blank PDF with ${pageCount} page(s)`,
      },
    };
  },
};
