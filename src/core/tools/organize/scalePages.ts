import { loadForEditing, saveEdited } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  numberParam,
  passwordParam,
  pdfOutput,
  soleFile,
  stringParam,
} from '../shared.ts';

const TARGET_SIZES: Record<string, [number, number]> = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
};

export const scalePagesTool: ToolDescriptor = {
  id: 'organize.scale-pages',
  category: 'organize',
  name: { zh: '缩放页面', en: 'Scale Pages' },
  description: {
    zh: '把所有页面统一缩放到指定纸型，或按百分比缩放，内容等比居中。',
    en: 'Scale every page to a standard paper size, or by a percentage — content stays proportional and centred.',
  },
  icon: 'Scaling',
  keywords: ['scale', 'resize', 'paper', 'a4', 'letter', '缩放', '纸型', '调整大小'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'mode',
      type: 'select',
      label: { zh: '缩放方式', en: 'Scale by' },
      default: 'paper',
      options: [
        { value: 'paper', label: { zh: '统一到纸型', en: 'To a paper size' } },
        { value: 'percent', label: { zh: '按百分比', en: 'By percentage' } },
      ],
    },
    {
      key: 'paper',
      type: 'select',
      label: { zh: '目标纸型', en: 'Paper size' },
      default: 'a4',
      options: [
        { value: 'a4', label: { zh: 'A4', en: 'A4' } },
        { value: 'a3', label: { zh: 'A3', en: 'A3' } },
        { value: 'a5', label: { zh: 'A5', en: 'A5' } },
        { value: 'letter', label: { zh: 'Letter', en: 'Letter' } },
        { value: 'legal', label: { zh: 'Legal', en: 'Legal' } },
      ],
      visibleWhen: { key: 'mode', equals: ['paper'] },
    },
    {
      key: 'landscape',
      type: 'boolean',
      label: { zh: '横向', en: 'Landscape' },
      default: false,
      visibleWhen: { key: 'mode', equals: ['paper'] },
    },
    {
      key: 'percent',
      type: 'number',
      label: { zh: '缩放比例', en: 'Scale' },
      unit: { zh: '%', en: '%' },
      default: 100,
      min: 10,
      max: 400,
      visibleWhen: { key: 'mode', equals: ['percent'] },
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const mode = stringParam(ctx, 'mode');

    const doc = await loadForEditing(file.bytes, stringParam(ctx, 'password'));

    if (mode === 'percent') {
      const factor = numberParam(ctx, 'percent') / 100;
      for (const page of doc.getPages()) page.scale(factor, factor);
    } else {
      const preset = TARGET_SIZES[stringParam(ctx, 'paper')] ?? (TARGET_SIZES.a4 as [number, number]);
      const landscape = ctx.params.landscape === true;
      const [targetWidth, targetHeight] = landscape ? [preset[1], preset[0]] : preset;

      for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        const factor = Math.min(targetWidth / width, targetHeight / height);
        // Scale boxes + content together, then re-frame on the target size and
        // centre what is now a smaller (or equal) content area.
        page.scale(factor, factor);
        page.setSize(targetWidth, targetHeight);
        page.translateContent(
          (targetWidth - width * factor) / 2,
          (targetHeight - height * factor) / 2,
        );
      }
    }

    const bytes = await saveEdited(doc);
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(file.name, '_scaled', '.pdf'), bytes)],
      summary: {
        zh: `已缩放 ${doc.getPageCount()} 页`,
        en: `Scaled ${doc.getPageCount()} pages`,
      },
    };
  },
};
