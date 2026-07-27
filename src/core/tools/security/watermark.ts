import { openDocument, saveDocument } from '../../pdf/document.ts';
import { stampTextOnPage } from '../../pdf/overlay.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  boolParam,
  checkCancelled,
  numberParam,
  pageRangeParam,
  passwordParam,
  pdfOutput,
  reportStep,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

export const addWatermarkTool: ToolDescriptor = {
  id: 'security.add-watermark',
  category: 'security',
  name: { zh: '添加水印', en: 'Add Watermark' },
  description: {
    zh: '给页面盖上半透明文字水印，支持中文、旋转和平铺。',
    en: 'Stamp pages with translucent text — CJK, rotation and tiling included.',
  },
  icon: 'Stamp',
  keywords: ['watermark', 'stamp', 'confidential', 'draft', '水印', '机密', '盖章'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'text',
      type: 'text',
      label: { zh: '水印文字', en: 'Watermark text' },
      placeholder: { zh: '例如：机密 · 仅供内部使用', en: 'e.g. CONFIDENTIAL — internal use only' },
      default: '',
      required: true,
      maxLength: 100,
    },
    {
      key: 'size',
      type: 'number',
      label: { zh: '字号', en: 'Font size' },
      unit: { zh: '磅', en: 'pt' },
      default: 48,
      min: 8,
      max: 200,
      integer: true,
    },
    {
      key: 'opacity',
      type: 'number',
      label: { zh: '不透明度', en: 'Opacity' },
      help: { zh: '0.1 隐约可见，1 完全不透明。', en: '0.1 is faint, 1 is solid.' },
      default: 0.15,
      min: 0.05,
      max: 1,
      step: 0.05,
    },
    {
      key: 'rotation',
      type: 'number',
      label: { zh: '旋转角度', en: 'Rotation' },
      unit: { zh: '°', en: '°' },
      default: 45,
      min: -90,
      max: 90,
      integer: true,
    },
    {
      key: 'color',
      type: 'color',
      label: { zh: '颜色', en: 'Colour' },
      default: '#888888',
    },
    {
      key: 'tile',
      type: 'boolean',
      label: { zh: '平铺整页', en: 'Tile across the page' },
      help: {
        zh: '重复铺满页面，比单个水印更难裁掉。',
        en: 'Repeats across the whole page — much harder to crop out than a single stamp.',
      },
      default: false,
    },
    pageRangeParam({ label: { zh: '应用到哪些页', en: 'Apply to pages' } }),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const spec = {
      text: stringParam(ctx, 'text'),
      size: numberParam(ctx, 'size'),
      color: stringParam(ctx, 'color'),
      opacity: numberParam(ctx, 'opacity'),
      rotateDegrees: numberParam(ctx, 'rotation'),
      tile: boolParam(ctx, 'tile'),
    };

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const pages = resolvePages(ctx, 'pages', doc.countPages());

      for (const [index, page] of pages.entries()) {
        checkCancelled(ctx);
        stampTextOnPage(doc, page - 1, spec);
        reportStep(ctx, index + 1, pages.length + 1, {
          zh: `正在处理第 ${page} 页`,
          en: `Stamping page ${page}`,
        });
      }

      const bytes = saveDocument(doc, { garbage: 'compact' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_watermarked', '.pdf'), bytes)],
        summary: {
          zh: `已为 ${pages.length} 页加上「${spec.text}」水印`,
          en: `Watermarked ${pages.length} pages with "${spec.text}"`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
