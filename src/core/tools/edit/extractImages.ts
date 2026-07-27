import type * as mupdf from 'mupdf';
import { ToolError } from '../../errors.ts';
import { withDocumentSync } from '../../pdf/document.ts';
import { stemOf, sanitizeFileName } from '../../naming.ts';
import type { ToolDescriptor, ToolOutputFile } from '../../types.ts';
import {
  PDF_ONE,
  checkCancelled,
  numberParam,
  passwordParam,
  reportStep,
  soleFile,
  stringParam,
} from '../shared.ts';

interface FoundImage {
  object: mupdf.PDFObject;
  /** Indirect object number, the dedupe key — one image reused on 50 pages is one file. */
  ref: number;
  /** First page (1-based) the image appears on, for naming. */
  page: number;
}

/** Walks every page's XObject dictionary for /Image entries, deduplicated by ref. */
export function findImages(doc: mupdf.PDFDocument): FoundImage[] {
  const seen = new Set<number>();
  const found: FoundImage[] = [];

  const pageCount = doc.countPages();
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const resources = doc.loadPage(pageIndex).getObject().get('Resources');
    if (!resources || resources.isNull()) continue;
    const xobjects = resources.get('XObject');
    if (!xobjects || xobjects.isNull()) continue;

    xobjects.forEach((value: mupdf.PDFObject) => {
      if (String(value.get('Subtype')) !== '/Image') return;
      const ref = value.asIndirect();
      if (seen.has(ref)) return;
      seen.add(ref);
      found.push({ object: value, ref, page: pageIndex + 1 });
    });
  }

  return found;
}

/**
 * Exports one embedded image.
 *
 * JPEG streams (`DCTDecode`) are copied out verbatim — re-encoding a JPEG only
 * loses quality. Everything else (Flate, JPX, CCITT fax, …) goes through
 * MuPDF's own decoder to lossless PNG.
 */
export function exportImage(
  doc: mupdf.PDFDocument,
  image: FoundImage,
): { bytes: Uint8Array; extension: string; mime: string } {
  const filter = String(image.object.get('Filter'));

  if (filter.includes('DCTDecode')) {
    const raw = image.object.readRawStream();
    return { bytes: new Uint8Array(raw.asUint8Array()), extension: '.jpg', mime: 'image/jpeg' };
  }

  const decoded = doc.loadImage(image.object);
  try {
    const pixmap = decoded.toPixmap();
    try {
      return { bytes: pixmap.asPNG(), extension: '.png', mime: 'image/png' };
    } finally {
      pixmap.destroy();
    }
  } finally {
    decoded.destroy();
  }
}

export const extractImagesTool: ToolDescriptor = {
  id: 'edit.extract-images',
  category: 'edit',
  name: { zh: '提取图片', en: 'Extract Images' },
  description: {
    zh: '把 PDF 里嵌入的原始图片抽取出来。JPG 原样导出不重压缩，其余转为 PNG。',
    en: 'Pull the embedded images out of a PDF. JPGs are copied losslessly; the rest become PNG.',
  },
  icon: 'Images',
  keywords: ['extract', 'images', 'pictures', 'photos', '提取图片', '导出图片', '抽图'],
  input: PDF_ONE,
  output: 'multiple',
  params: [
    {
      key: 'minSize',
      type: 'number',
      label: { zh: '忽略小于此宽高的图片', en: 'Skip images smaller than' },
      unit: { zh: '像素', en: 'px' },
      help: {
        zh: '过滤图标、分隔线等装饰性小图。设为 1 则导出全部。',
        en: 'Filters out icons, rules and other decorative fragments. Set to 1 to export everything.',
      },
      default: 32,
      min: 1,
      max: 4096,
      integer: true,
      advanced: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const minSize = numberParam(ctx, 'minSize');

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const images = findImages(doc).filter((image) => {
        const width = Number(String(image.object.get('Width')));
        const height = Number(String(image.object.get('Height')));
        return width >= minSize && height >= minSize;
      });

      if (images.length === 0) {
        throw new ToolError('EMPTY_RESULT', 'Document contains no images above the size threshold', {
          zh: '这个文档里没有找到符合尺寸要求的图片。',
          en: 'No images above the size threshold were found in this document.',
        });
      }

      const stem = stemOf(file.name);
      const files: ToolOutputFile[] = images.map((image, index) => {
        checkCancelled(ctx);
        const exported = exportImage(doc, image);
        reportStep(ctx, index + 1, images.length, {
          zh: `正在导出第 ${index + 1}/${images.length} 张图片`,
          en: `Exporting image ${index + 1} of ${images.length}`,
        });
        return {
          name: sanitizeFileName(
            `${stem}_p${image.page}_img${index + 1}${exported.extension}`,
          ),
          bytes: exported.bytes,
          mime: exported.mime,
        };
      });

      return {
        files,
        summary: {
          zh: `已提取 ${files.length} 张图片`,
          en: `Extracted ${files.length} images`,
        },
      };
    });
  },
};
