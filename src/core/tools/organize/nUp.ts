import { PDFDocument } from 'pdf-lib';
import { decryptToBytes } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  checkCancelled,
  numberParam,
  passwordParam,
  pdfOutput,
  reportStep,
  soleFile,
  stringParam,
} from '../shared.ts';

/** Grid shape per N, and whether the sheet is turned to landscape. */
export const N_UP_LAYOUTS: Record<string, { cols: number; rows: number; rotate: boolean }> = {
  '2': { cols: 2, rows: 1, rotate: true },
  '4': { cols: 2, rows: 2, rotate: false },
  '6': { cols: 3, rows: 2, rotate: true },
  '9': { cols: 3, rows: 3, rotate: false },
  '16': { cols: 4, rows: 4, rotate: false },
};

export const nUpTool: ToolDescriptor = {
  id: 'organize.n-up',
  category: 'organize',
  name: { zh: '多页合一', en: 'N-up' },
  description: {
    zh: '把 2、4、6、9 或 16 页缩排到一张纸上——省纸打印和讲义排版的标配。',
    en: 'Lay 2, 4, 6, 9 or 16 pages out on one sheet — the classic for handouts and economical printing.',
  },
  icon: 'Grid2x2',
  keywords: ['n-up', 'nup', 'handout', 'multiple', 'sheet', '多页合一', '省纸', '讲义', '缩排'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'n',
      type: 'select',
      label: { zh: '每张纸的页数', en: 'Pages per sheet' },
      default: '2',
      options: [
        { value: '2', label: { zh: '2 页（横排）', en: '2-up (side by side)' } },
        { value: '4', label: { zh: '4 页（2×2）', en: '4-up (2 × 2)' } },
        { value: '6', label: { zh: '6 页（3×2）', en: '6-up (3 × 2)' } },
        { value: '9', label: { zh: '9 页（3×3）', en: '9-up (3 × 3)' } },
        { value: '16', label: { zh: '16 页（4×4）', en: '16-up (4 × 4)' } },
      ],
    },
    {
      key: 'gap',
      type: 'number',
      label: { zh: '间距', en: 'Gap' },
      unit: { zh: '磅', en: 'pt' },
      default: 12,
      min: 0,
      max: 72,
      advanced: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const layout = N_UP_LAYOUTS[stringParam(ctx, 'n')] ?? (N_UP_LAYOUTS['2'] as { cols: number; rows: number; rotate: boolean });
    const gap = numberParam(ctx, 'gap');
    const perSheet = layout.cols * layout.rows;

    const plain = decryptToBytes(file.bytes, stringParam(ctx, 'password'));
    const source = await PDFDocument.load(plain, { updateMetadata: false });
    const pageCount = source.getPageCount();

    const out = await PDFDocument.create();
    out.setProducer('MagiesPdf');
    const embedded = await out.embedPdf(plain, [...Array(pageCount).keys()]);

    // Sheets inherit the first page's size, turned sideways when the grid wants it.
    const firstPage = source.getPage(0).getSize();
    const [sheetWidth, sheetHeight] = layout.rotate
      ? [Math.max(firstPage.width, firstPage.height), Math.min(firstPage.width, firstPage.height)]
      : [firstPage.width, firstPage.height];

    const cellWidth = (sheetWidth - gap * (layout.cols + 1)) / layout.cols;
    const cellHeight = (sheetHeight - gap * (layout.rows + 1)) / layout.rows;

    const sheetCount = Math.ceil(pageCount / perSheet);
    for (let sheet = 0; sheet < sheetCount; sheet += 1) {
      checkCancelled(ctx);
      const page = out.addPage([sheetWidth, sheetHeight]);

      for (let cell = 0; cell < perSheet; cell += 1) {
        const index = sheet * perSheet + cell;
        const source_ = embedded[index];
        if (!source_) break;

        const col = cell % layout.cols;
        // Row 0 is the top of the sheet; PDF y grows upward.
        const row = Math.floor(cell / layout.cols);

        const scale = Math.min(cellWidth / source_.width, cellHeight / source_.height);
        const drawWidth = source_.width * scale;
        const drawHeight = source_.height * scale;

        page.drawPage(source_, {
          x: gap + col * (cellWidth + gap) + (cellWidth - drawWidth) / 2,
          y: sheetHeight - gap - (row + 1) * cellHeight - row * gap + (cellHeight - drawHeight) / 2,
          xScale: scale,
          yScale: scale,
        });
      }

      reportStep(ctx, sheet + 1, sheetCount, {
        zh: `正在排版第 ${sheet + 1}/${sheetCount} 张`,
        en: `Laying out sheet ${sheet + 1} of ${sheetCount}`,
      });
    }

    const bytes = await out.save({ useObjectStreams: true });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(file.name, `_${perSheet}up`, '.pdf'), bytes)],
      summary: {
        zh: `已把 ${pageCount} 页排成 ${sheetCount} 张（每张 ${perSheet} 页）`,
        en: `Arranged ${pageCount} pages onto ${sheetCount} sheets, ${perSheet} per sheet`,
      },
    };
  },
};
