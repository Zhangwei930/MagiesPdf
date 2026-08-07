import type * as mupdf from 'mupdf';
import { PDFDocument } from 'pdf-lib';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { findImages } from './extractImages.ts';
import {
  PDF_ONE,
  checkCancelled,
  passwordParam,
  pdfOutput,
  soleFile,
  stringParam,
} from '../shared.ts';

/**
 * Compress is two very different jobs:
 *
 * - **standard** — lossless structure: garbage-collect, object streams, re-Flate
 *   image/font streams. Already-tight PDFs (most exports) only lose a few KB.
 * - **aggressive** — lossy: re-JPEG embedded images, and rebuild pages as JPEG
 *   when that wins. This is what actually moves megabytes on scans; selectable
 *   text is lost when a page is rasterised.
 */

const LOSSLESS_SAVE = {
  compress: true,
  compressImages: true,
  compressFonts: true,
  objstms: true,
  garbage: 'deduplicate' as const,
  clean: true,
  sanitize: true,
};

/** Ignore decorative icons / rules when re-encoding. */
const MIN_IMAGE_PIXELS = 96 * 96;
/** Only rewrite an image when the new JPEG is meaningfully smaller. */
const IMAGE_WORTH_IT = 0.92;
/** Cap the long edge when rasterising so big point-size pages stay manageable. */
const RASTER_MAX_EDGE_PX = 1600;
const RASTER_QUALITY = 65;

export const compressTool: ToolDescriptor = {
  id: 'edit.compress',
  category: 'edit',
  name: { zh: '压缩 PDF', en: 'Compress PDF' },
  description: {
    zh: '减小 PDF 体积。标准模式无损清理结构；强力会重压图片/整页转 JPEG（扫描件可明显变小，文字可能不可再选中）。',
    en: 'Shrink a PDF. Standard is lossless structure clean-up; Aggressive re-encodes images / pages as JPEG (big wins on scans; text may no longer be selectable).',
  },
  icon: 'Minimize2',
  keywords: ['compress', 'shrink', 'reduce', 'optimize', 'size', '压缩', '瘦身', '减小'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'level',
      type: 'select',
      label: { zh: '压缩力度', en: 'Effort' },
      default: 'aggressive',
      options: [
        {
          value: 'standard',
          label: { zh: '标准（无损）', en: 'Standard (lossless)' },
          help: {
            zh: '合并重复对象、压缩数据流。已很紧凑的文件往往只省几 KB。',
            en: 'Deduplicate objects and re-Flate streams. Already-tight files often only save a few KB.',
          },
        },
        {
          value: 'aggressive',
          label: { zh: '强力（重压图片）', en: 'Aggressive (re-encode images)' },
          help: {
            zh: '重压嵌入图，必要时整页转 JPEG。体积可降很多，画质与可选文字会有损失。',
            en: 'Re-JPEG embedded images, and rasterise pages when that is smaller. Much smaller files; some quality / text loss.',
          },
        },
      ],
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const aggressive = stringParam(ctx, 'level') === 'aggressive';
    const before = file.bytes.length;

    let bytes: Uint8Array;
    let note: { zh: string; en: string };

    if (!aggressive) {
      const doc = openDocument(file.bytes, password);
      try {
        bytes = saveDocument(doc, LOSSLESS_SAVE);
        note = { zh: '无损结构压缩', en: 'lossless structure pass' };
      } finally {
        doc.destroy();
      }
      ctx.report(1);
    } else {
      const result = await compressAggressive(file.bytes, password, (fraction) => {
        ctx.report(fraction);
        checkCancelled(ctx);
      });
      bytes = result.bytes;
      note = result.note;
    }

    // Never hand back a larger file — that is not "compression".
    if (bytes.length >= before) {
      return {
        files: [pdfOutput(suffixedName(file.name, '_compressed', '.pdf'), file.bytes)],
        summary: {
          zh: `文件已经很紧凑（${formatSize(before)}），没有可压缩的空间`,
          en: `Already compact (${formatSize(before)}) — nothing left to squeeze`,
        },
      };
    }

    const saved = before - bytes.length;
    const percent = Math.round((saved / before) * 100);

    return {
      files: [pdfOutput(suffixedName(file.name, '_compressed', '.pdf'), bytes)],
      summary: {
        zh: `体积减小 ${percent}%（${formatSize(before)} → ${formatSize(bytes.length)}，${note.zh}）`,
        en: `${percent}% smaller (${formatSize(before)} → ${formatSize(bytes.length)}, ${note.en})`,
      },
    };
  },
};

async function compressAggressive(
  sourceBytes: Uint8Array,
  password: string,
  report: (fraction: number) => void,
): Promise<{ bytes: Uint8Array; note: { zh: string; en: string } }> {
  report(0.05);

  // Path A — re-JPEG embedded images + lossless save (keeps vector text).
  let imageBytes = sourceBytes;
  let imageCount = 0;
  {
    const doc = openDocument(sourceBytes, password);
    try {
      imageCount = recompressEmbeddedImages(doc, 62);
      report(0.35);
      imageBytes = saveDocument(doc, LOSSLESS_SAVE);
    } finally {
      doc.destroy();
    }
  }

  // Path B — full-page JPEG rebuild (wins on scans / photo pages).
  report(0.4);
  const rasterBytes = await rasterisePages(sourceBytes, password, report);

  type Candidate = { bytes: Uint8Array; note: { zh: string; en: string } };
  const candidates: Candidate[] = [
    {
      bytes: imageBytes,
      note:
        imageCount > 0
          ? { zh: `重压了 ${imageCount} 张图`, en: `re-encoded ${imageCount} image(s)` }
          : { zh: '无损结构 + 图片流压缩', en: 'structure + image-stream compression' },
    },
    {
      bytes: rasterBytes,
      note: { zh: '整页 JPEG 重编码', en: 'full-page JPEG re-encode' },
    },
  ];

  candidates.sort((a, b) => a.bytes.length - b.bytes.length);
  const best = candidates[0];
  if (!best) {
    return {
      bytes: sourceBytes,
      note: { zh: '无损结构压缩', en: 'lossless structure pass' },
    };
  }
  return best;
}

/**
 * Decode each large image, write it back as JPEG via writeRawStream, fix the
 * image dictionary. Soft-masked / alpha images are left alone.
 */
export function recompressEmbeddedImages(doc: mupdf.PDFDocument, quality: number): number {
  const images = findImages(doc);
  let changed = 0;

  for (const entry of images) {
    // Image XObjects are stream dicts; do not resolve() — that can yield a
    // non-stream and writeRawStream/readRawStream then fail.
    const obj = entry.object;
    if (!obj.isIndirect()) continue;

    let beforeLen = 0;
    try {
      const raw = obj.readRawStream();
      try {
        beforeLen = raw.asUint8Array().length;
      } finally {
        raw.destroy();
      }
    } catch {
      continue;
    }

    let image: mupdf.Image;
    try {
      image = doc.loadImage(obj);
    } catch {
      continue;
    }

    try {
      const pixmap = image.toPixmap();
      try {
        const width = pixmap.getWidth();
        const height = pixmap.getHeight();
        if (width * height < MIN_IMAGE_PIXELS) continue;
        if (pixmap.getAlpha()) continue;

        const ncomp = pixmap.getNumberOfComponents();
        if (ncomp !== 1 && ncomp !== 3) continue;

        const jpeg = pixmap.asJPEG(quality, false);
        if (jpeg.length >= beforeLen * IMAGE_WORTH_IT) continue;

        const cs = ncomp === 1 ? doc.newName('DeviceGray') : doc.newName('DeviceRGB');

        obj.writeRawStream(jpeg);
        obj.put('Filter', doc.newName('DCTDecode'));
        obj.put('ColorSpace', cs);
        obj.put('BitsPerComponent', doc.newInteger(8));
        obj.put('Width', doc.newInteger(width));
        obj.put('Height', doc.newInteger(height));
        obj.put('Length', doc.newInteger(jpeg.length));
        try {
          obj.delete('DecodeParms');
        } catch {
          // optional
        }
        changed += 1;
      } finally {
        pixmap.destroy();
      }
    } finally {
      image.destroy();
    }
  }

  return changed;
}

async function rasterisePages(
  sourceBytes: Uint8Array,
  password: string,
  report: (fraction: number) => void,
): Promise<Uint8Array> {
  const source = openDocument(sourceBytes, password);
  try {
    const pageCount = source.countPages();
    const out = await PDFDocument.create();
    out.setProducer('MagiesPdf');

    for (let i = 0; i < pageCount; i += 1) {
      report(0.4 + (0.55 * i) / Math.max(pageCount, 1));
      const bounds = source.loadPage(i).getBounds();
      const widthPt = Math.max(1, bounds[2] - bounds[0]);
      const heightPt = Math.max(1, bounds[3] - bounds[1]);
      // Keep the long edge ≤ RASTER_MAX_EDGE_PX so photo-sized page boxes do not
      // explode into multi-megapixel rasters that end up larger than the source.
      const longPt = Math.max(widthPt, heightPt);
      const dpi = Math.min(150, (RASTER_MAX_EDGE_PX / longPt) * 72);

      const rendered = renderPage(source, i, {
        dpi,
        format: 'jpeg',
        quality: RASTER_QUALITY,
      });
      const image = await out.embedJpg(rendered.bytes);
      const page = out.addPage([widthPt, heightPt]);
      page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
    }

    return new Uint8Array(await out.save({ useObjectStreams: true }));
  } finally {
    source.destroy();
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
