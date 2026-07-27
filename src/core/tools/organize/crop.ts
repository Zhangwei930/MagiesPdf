import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { analyzePageInk } from '../../pdf/render.ts';
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

function marginParam(key: string, zh: string, en: string) {
  return {
    key,
    type: 'number' as const,
    label: { zh, en },
    unit: { zh: '磅', en: 'pt' },
    default: 0,
    min: 0,
    max: 2000,
    visibleWhen: { key: 'mode', equals: ['margins'] },
  };
}

export const cropTool: ToolDescriptor = {
  id: 'organize.crop',
  category: 'organize',
  name: { zh: '裁剪页面', en: 'Crop Pages' },
  description: {
    zh: '按边距裁掉页面四周，或自动检测内容范围去除白边。',
    en: 'Trim the page edges by fixed margins, or auto-detect the content and cut the white away.',
  },
  icon: 'Crop',
  keywords: ['crop', 'trim', 'margins', 'white space', '裁剪', '白边', '边距', '去白'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'mode',
      type: 'select',
      label: { zh: '裁剪方式', en: 'Crop by' },
      default: 'auto',
      options: [
        { value: 'auto', label: { zh: '自动去白边', en: 'Auto-trim white margins' } },
        { value: 'margins', label: { zh: '固定边距', en: 'Fixed margins' } },
      ],
    },
    {
      key: 'padding',
      type: 'number',
      label: { zh: '内容四周保留', en: 'Keep around the content' },
      unit: { zh: '磅', en: 'pt' },
      default: 12,
      min: 0,
      max: 200,
      visibleWhen: { key: 'mode', equals: ['auto'] },
    },
    marginParam('top', '上边裁掉', 'Trim from top'),
    marginParam('bottom', '下边裁掉', 'Trim from bottom'),
    marginParam('left', '左边裁掉', 'Trim from left'),
    marginParam('right', '右边裁掉', 'Trim from right'),
    {
      key: 'hardCrop',
      type: 'boolean',
      label: { zh: '彻底裁切（同时修改 MediaBox）', en: 'Hard crop (also change the MediaBox)' },
      help: {
        zh: '默认只设置显示区域（CropBox），原始内容仍在文件里、可撤销。勾选后连底层页面尺寸一起改。',
        en: 'By default only the visible area (CropBox) changes and the crop is reversible. Tick to change the underlying page box too.',
      },
      default: false,
      advanced: true,
    },
    pageRangeParam({ label: { zh: '裁剪哪些页', en: 'Pages to crop' } }),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const mode = stringParam(ctx, 'mode');
    const hardCrop = boolParam(ctx, 'hardCrop');

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const pages = resolvePages(ctx, 'pages', doc.countPages());

      for (const [index, pageNumber] of pages.entries()) {
        checkCancelled(ctx);
        const page = doc.loadPage(pageNumber - 1);
        const [x0, y0, x1, y1] = page.getBounds();

        let box: [number, number, number, number];
        if (mode === 'auto') {
          const padding = numberParam(ctx, 'padding');
          const ink = analyzePageInk(doc, pageNumber - 1);
          // A blank page has nothing to crop to; leave it untouched.
          if (!ink.bbox) continue;
          box = [
            Math.max(x0, ink.bbox.x0 - padding),
            Math.max(y0, ink.bbox.y0 - padding),
            Math.min(x1, ink.bbox.x1 + padding),
            Math.min(y1, ink.bbox.y1 + padding),
          ];
        } else {
          box = [
            x0 + numberParam(ctx, 'left'),
            y0 + numberParam(ctx, 'bottom'),
            x1 - numberParam(ctx, 'right'),
            y1 - numberParam(ctx, 'top'),
          ];
          if (box[0] >= box[2] || box[1] >= box[3]) {
            throw new ToolError(
              'INVALID_PARAM',
              `Margins consume the whole page (${x1 - x0}×${y1 - y0}pt)`,
              {
                zh: `边距加起来超过了页面尺寸（第 ${pageNumber} 页为 ${Math.round(x1 - x0)}×${Math.round(y1 - y0)} 磅），请调小。`,
                en: `The margins consume the entire page (page ${pageNumber} is ${Math.round(x1 - x0)}×${Math.round(y1 - y0)}pt). Reduce them.`,
              },
            );
          }
        }

        const pageObj = page.getObject();
        const boxArray = doc.newArray();
        for (const value of box) boxArray.push(Math.round(value * 100) / 100);
        pageObj.put('CropBox', boxArray);
        if (hardCrop) pageObj.put('MediaBox', boxArray);

        reportStep(ctx, index + 1, pages.length, {
          zh: `正在裁剪第 ${pageNumber} 页`,
          en: `Cropping page ${pageNumber}`,
        });
      }

      const bytes = saveDocument(doc, { garbage: 'compact' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_cropped', '.pdf'), bytes)],
        summary: {
          zh: `已裁剪 ${pages.length} 页`,
          en: `Cropped ${pages.length} pages`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
