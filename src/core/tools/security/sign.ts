import { PDFDocument, rgb, StandardFonts, type PDFImage, type PDFPage } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { decryptToBytes } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor, ToolInputFile } from '../../types.ts';
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

/**
 * Visible signature block (image and/or typed name).
 *
 * This is intentionally a *visual* signature for everyday document workflows —
 * stamping a handwritten image or a typed sign-off onto pages. Cryptographic
 * certificate signing is out of scope until the engine exposes it.
 */
export const addSignatureTool: ToolDescriptor = {
  id: 'security.add-signature',
  category: 'security',
  name: { zh: '添加签名', en: 'Add Signature' },
  description: {
    zh: '在页面上盖上手写签名图或姓名签章（可见签名，非数字证书）。第一个文件是 PDF；用图片签名时再加 PNG/JPG。',
    en: 'Stamp a handwritten image or typed name onto pages (visible signature, not a digital certificate). PDF first; add a PNG/JPG for image mode.',
  },
  icon: 'PenLine',
  keywords: [
    'signature',
    'sign',
    'autograph',
    'handwritten',
    '签名',
    '签字',
    '手写',
    '签章',
  ],
  input: {
    accept: ['.pdf', '.png', '.jpg', '.jpeg'],
    min: 1,
    max: 2,
    ordered: true,
  },
  output: 'single',
  params: [
    {
      key: 'mode',
      type: 'select',
      label: { zh: '签名方式', en: 'Signature mode' },
      default: 'image',
      options: [
        { value: 'image', label: { zh: '图片 / 手绘', en: 'Image / drawn' } },
        { value: 'text', label: { zh: '文字姓名', en: 'Typed name' } },
        { value: 'both', label: { zh: '图片 + 文字', en: 'Image + text' } },
      ],
    },
    {
      key: 'signerName',
      type: 'text',
      label: { zh: '签署人姓名', en: 'Signer name' },
      default: '',
      maxLength: 80,
      visibleWhen: { key: 'mode', equals: ['text', 'both'] },
    },
    {
      key: 'reason',
      type: 'text',
      label: { zh: '签署原因', en: 'Reason' },
      default: '',
      maxLength: 120,
      advanced: true,
      visibleWhen: { key: 'mode', equals: ['text', 'both'] },
    },
    {
      key: 'includeDate',
      type: 'boolean',
      label: { zh: '附带签署日期', en: 'Include date' },
      default: true,
      visibleWhen: { key: 'mode', equals: ['text', 'both'] },
    },
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
      label: { zh: '签名宽度（占页宽）', en: 'Signature width (of page width)' },
      unit: { zh: '%', en: '%' },
      default: 28,
      min: 8,
      max: 80,
    },
    {
      key: 'opacity',
      type: 'number',
      label: { zh: '不透明度', en: 'Opacity' },
      default: 1,
      min: 0.2,
      max: 1,
      step: 0.05,
      advanced: true,
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
    {
      key: 'pages',
      type: 'pageRange',
      label: { zh: '签到哪些页', en: 'Pages to sign' },
      default: 'last',
      required: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const mode = stringParam(ctx, 'mode');
    const { pdfFile, imageFile } = splitInputs(ctx.files, mode);

    const doc = await PDFDocument.load(
      decryptToBytes(pdfFile.bytes, stringParam(ctx, 'password')),
      { updateMetadata: false },
    );

    let image: PDFImage | null = null;
    if (mode === 'image' || mode === 'both') {
      if (!imageFile) {
        throw new ToolError('INVALID_INPUT', 'Image signature needs a PNG/JPG', {
          zh: '图片签名需要再提供一张 PNG/JPG（或用手绘面板）。',
          en: 'Image mode needs a PNG/JPG (or use the draw panel).',
        });
      }
      const kind = sniffImage(imageFile.bytes);
      if (!kind) {
        throw new ToolError('UNSUPPORTED_FORMAT', `"${imageFile.name}" is not a PNG or JPEG`, {
          zh: `「${imageFile.name}」不是有效的 PNG 或 JPG。`,
          en: `"${imageFile.name}" is not a valid PNG or JPG.`,
        });
      }
      image =
        kind === 'png'
          ? await doc.embedPng(imageFile.bytes)
          : await doc.embedJpg(imageFile.bytes);
    }

    const signerName = stringParam(ctx, 'signerName').trim();
    if ((mode === 'text' || mode === 'both') && signerName === '') {
      throw new ToolError('INVALID_PARAM', 'signerName is required for text signatures', {
        zh: '文字签名需要填写签署人姓名。',
        en: 'Typed signatures need a signer name.',
      });
    }

    const position = stringParam(ctx, 'position') as Corner;
    const widthPercent = numberParam(ctx, 'widthPercent') / 100;
    const opacity = numberParam(ctx, 'opacity');
    const margin = numberParam(ctx, 'margin');
    const reason = stringParam(ctx, 'reason').trim();
    const includeDate = ctx.params.includeDate !== false;
    const targets = resolvePages(ctx, 'pages', doc.getPageCount());
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);
    const dateLine = includeDate ? formatSignDate(new Date()) : '';

    for (const [index, pageNumber] of targets.entries()) {
      checkCancelled(ctx);
      const page = doc.getPage(pageNumber - 1);
      drawSignatureBlock(page, {
        image,
        signerName,
        reason,
        dateLine,
        position,
        widthPercent,
        opacity,
        margin,
        font,
        fontItalic,
        mode,
      });
      reportStep(ctx, index + 1, targets.length, {
        zh: `正在签署第 ${pageNumber} 页`,
        en: `Signing page ${pageNumber}`,
      });
    }

    // Light metadata hint that this file was signed in MagiesPdf (visible only).
    if (signerName) {
      const previous = doc.getAuthor() ?? '';
      if (!previous) doc.setAuthor(signerName);
    }

    const bytes = await doc.save({ useObjectStreams: true });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(pdfFile.name, '_signed', '.pdf'), bytes)],
      summary: {
        zh: `已在 ${targets.length} 页添加签名`,
        en: `Added a signature on ${targets.length} page(s)`,
      },
    };
  },
};

function splitInputs(
  files: ToolInputFile[],
  mode: string,
): { pdfFile: ToolInputFile; imageFile: ToolInputFile | null } {
  const pdfFile = files.find((f) => f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfFile) {
    throw new ToolError('INVALID_INPUT', 'A PDF is required', {
      zh: '请先选择要签署的 PDF。',
      en: 'Choose a PDF to sign first.',
    });
  }
  const imageFile =
    files.find((f) => f !== pdfFile && sniffImage(f.bytes) !== null) ?? null;

  if ((mode === 'image' || mode === 'both') && !imageFile && files.length >= 2) {
    const other = files.find((f) => f !== pdfFile);
    throw new ToolError(
      'UNSUPPORTED_FORMAT',
      `"${other?.name ?? 'file'}" is not a PNG or JPEG`,
      {
        zh: '第二个文件需要是 PNG 或 JPG 签名图。',
        en: 'The second file must be a PNG or JPG signature image.',
      },
    );
  }

  return { pdfFile, imageFile };
}

export function formatSignDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function drawSignatureBlock(
  page: PDFPage,
  options: {
    image: PDFImage | null;
    signerName: string;
    reason: string;
    dateLine: string;
    position: Corner;
    widthPercent: number;
    opacity: number;
    margin: number;
    font: Awaited<ReturnType<PDFDocument['embedFont']>>;
    fontItalic: Awaited<ReturnType<PDFDocument['embedFont']>>;
    mode: string;
  },
): void {
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const blockWidth = pageWidth * options.widthPercent;

  let imageHeight = 0;
  let imageWidth = 0;
  if (options.image) {
    imageWidth = blockWidth;
    imageHeight = imageWidth * (options.image.height / options.image.width);
  }

  const nameSize = 11;
  const metaSize = 9;
  const lineGap = 3;
  let textHeight = 0;
  if (options.mode === 'text' || options.mode === 'both') {
    if (options.signerName) textHeight += nameSize + lineGap;
    if (options.dateLine) textHeight += metaSize + lineGap;
    if (options.reason) textHeight += metaSize + lineGap;
  }

  const gap = options.image && textHeight > 0 ? 6 : 0;
  const blockHeight = imageHeight + gap + textHeight;

  let x: number;
  let y: number;
  if (options.position === 'center') {
    x = (pageWidth - blockWidth) / 2;
    y = (pageHeight - blockHeight) / 2;
  } else {
    x = options.position.endsWith('left')
      ? options.margin
      : pageWidth - options.margin - blockWidth;
    y = options.position.startsWith('bottom')
      ? options.margin
      : pageHeight - options.margin - blockHeight;
  }

  // Soft plate behind the signature so it stays legible on dark content.
  page.drawRectangle({
    x: x - 4,
    y: y - 4,
    width: blockWidth + 8,
    height: blockHeight + 8,
    color: rgb(1, 1, 1),
    opacity: 0.55 * options.opacity,
    borderWidth: 0,
  });

  let cursorY = y + blockHeight;

  if (options.image) {
    cursorY -= imageHeight;
    page.drawImage(options.image, {
      x,
      y: cursorY,
      width: imageWidth,
      height: imageHeight,
      opacity: options.opacity,
    });
    cursorY -= gap;
  }

  if (options.mode === 'text' || options.mode === 'both') {
    if (options.signerName) {
      cursorY -= nameSize;
      page.drawText(options.signerName, {
        x,
        y: cursorY,
        size: nameSize,
        font: options.fontItalic,
        color: rgb(0.1, 0.1, 0.15),
        opacity: options.opacity,
        maxWidth: blockWidth,
      });
      cursorY -= lineGap;
    }
    if (options.dateLine) {
      cursorY -= metaSize;
      page.drawText(options.dateLine, {
        x,
        y: cursorY,
        size: metaSize,
        font: options.font,
        color: rgb(0.35, 0.35, 0.4),
        opacity: options.opacity,
      });
      cursorY -= lineGap;
    }
    if (options.reason) {
      cursorY -= metaSize;
      page.drawText(options.reason, {
        x,
        y: cursorY,
        size: metaSize,
        font: options.font,
        color: rgb(0.35, 0.35, 0.4),
        opacity: options.opacity,
        maxWidth: blockWidth,
      });
    }
  }
}
