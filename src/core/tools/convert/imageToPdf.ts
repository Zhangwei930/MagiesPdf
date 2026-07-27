import { PDFDocument } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { stemOf } from '../../naming.ts';
import type { ToolDescriptor, ToolInputFile } from '../../types.ts';
import {
  checkCancelled,
  numberParam,
  pdfOutput,
  reportStep,
  stringParam,
} from '../shared.ts';

/** File-type sniffing: extensions lie, magic bytes do not. */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

const PAGE_SIZES: Record<string, [number, number]> = {
  a4: [595.28, 841.89],
  a4Landscape: [841.89, 595.28],
  letter: [612, 792],
};

export const imageToPdfTool: ToolDescriptor = {
  id: 'convert.image-to-pdf',
  category: 'convert',
  name: { zh: '图片转 PDF', en: 'Images to PDF' },
  description: {
    zh: '把多张 PNG/JPG 图片按顺序合成一个 PDF，一张一页。',
    en: 'Combine PNG/JPG images into one PDF, one image per page, in order.',
  },
  icon: 'FileImage',
  keywords: ['image', 'photo', 'scan', 'png', 'jpg', '图片', '照片', '扫描件'],
  input: { accept: ['.png', '.jpg', '.jpeg'], min: 1, max: null, ordered: true },
  output: 'single',
  params: [
    {
      key: 'pageSize',
      type: 'select',
      label: { zh: '页面大小', en: 'Page size' },
      default: 'fit',
      options: [
        { value: 'fit', label: { zh: '与图片一致', en: 'Match each image' } },
        { value: 'a4', label: { zh: 'A4 纵向', en: 'A4 portrait' } },
        { value: 'a4Landscape', label: { zh: 'A4 横向', en: 'A4 landscape' } },
        { value: 'letter', label: { zh: 'Letter', en: 'Letter' } },
      ],
    },
    {
      key: 'margin',
      type: 'number',
      label: { zh: '页边距', en: 'Margin' },
      unit: { zh: '磅', en: 'pt' },
      default: 24,
      min: 0,
      max: 200,
      visibleWhen: { key: 'pageSize', equals: ['a4', 'a4Landscape', 'letter'] },
    },
  ],
  runtime: 'worker',

  async run(ctx) {
    const pageSize = stringParam(ctx, 'pageSize');
    const margin = numberParam(ctx, 'margin');

    const doc = await PDFDocument.create();
    doc.setProducer('MagiesPdf');

    for (const [index, file] of ctx.files.entries()) {
      checkCancelled(ctx);
      await addImagePage(doc, file, pageSize, margin);
      reportStep(ctx, index + 1, ctx.files.length, {
        zh: `正在添加 ${file.name}（${index + 1}/${ctx.files.length}）`,
        en: `Adding ${file.name} (${index + 1} of ${ctx.files.length})`,
      });
    }

    const bytes = await doc.save({ useObjectStreams: true });
    const first = ctx.files[0] as ToolInputFile;
    const name =
      ctx.files.length === 1
        ? `${stemOf(first.name)}.pdf`
        : `${stemOf(first.name)}_+${ctx.files.length - 1}.pdf`;

    return {
      files: [pdfOutput(name, bytes)],
      summary: {
        zh: `已把 ${ctx.files.length} 张图片合成为 ${ctx.files.length} 页 PDF`,
        en: `Combined ${ctx.files.length} images into a ${ctx.files.length}-page PDF`,
      },
    };
  },
};

async function addImagePage(
  doc: PDFDocument,
  file: ToolInputFile,
  pageSize: string,
  margin: number,
): Promise<void> {
  const kind = sniffImage(file.bytes);
  if (!kind) {
    throw new ToolError(
      'UNSUPPORTED_FORMAT',
      `"${file.name}" is not a PNG or JPEG by magic bytes`,
      {
        zh: `「${file.name}」不是有效的 PNG 或 JPG 图片（文件内容与扩展名不符）。`,
        en: `"${file.name}" is not a valid PNG or JPG image — its content does not match its extension.`,
      },
      { file: file.name },
    );
  }

  const image =
    kind === 'png' ? await doc.embedPng(file.bytes) : await doc.embedJpg(file.bytes);

  if (pageSize === 'fit') {
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    return;
  }

  const [pageWidth, pageHeight] = PAGE_SIZES[pageSize] ?? PAGE_SIZES.a4 as [number, number];
  const page = doc.addPage([pageWidth, pageHeight]);

  // Contain-fit inside the margins, centred, never upscaled past 1:1.
  const availableWidth = pageWidth - margin * 2;
  const availableHeight = pageHeight - margin * 2;
  const scale = Math.min(availableWidth / image.width, availableHeight / image.height, 1);
  const width = image.width * scale;
  const height = image.height * scale;

  page.drawImage(image, {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  });
}
