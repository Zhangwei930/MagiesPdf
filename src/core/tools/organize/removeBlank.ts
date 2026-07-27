import { ToolError } from '../../errors.ts';
import { selectPages } from '../../pdf/assemble.ts';
import { withDocumentSync } from '../../pdf/document.ts';
import { analyzePageInk } from '../../pdf/render.ts';
import { formatPageRange } from '../../pageRange.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  checkCancelled,
  passwordParam,
  pdfOutput,
  reportStep,
  soleFile,
  stringParam,
} from '../shared.ts';

/** Ink thresholds per sensitivity: how much of the page may be inked and still count as blank. */
export const BLANK_THRESHOLDS: Record<string, number> = {
  // Only a perfectly empty render counts.
  strict: 0,
  // Tolerates scanner noise and stray specks. Calibration on A4 at 36 dpi: a
  // single 36 pt character measures ~0.0004 ink ratio, a short line ~0.001 —
  // both must survive "normal".
  normal: 0.0002,
  // Also drops near-blank pages: a lone page number (one or two characters)
  // goes, a real line of text stays.
  aggressive: 0.0008,
};

export const removeBlankTool: ToolDescriptor = {
  id: 'organize.remove-blank-pages',
  category: 'organize',
  name: { zh: '删除空白页', en: 'Remove Blank Pages' },
  description: {
    zh: '自动找出并删掉空白页，扫描件里的噪点也能正确识别。',
    en: 'Detect and drop blank pages — scanner noise is accounted for.',
  },
  icon: 'FileX',
  keywords: ['blank', 'empty', 'white', 'remove', '空白页', '空页', '删除空白'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'sensitivity',
      type: 'select',
      label: { zh: '判定标准', en: 'Sensitivity' },
      default: 'normal',
      options: [
        {
          value: 'strict',
          label: { zh: '严格（页面必须完全空白）', en: 'Strict (page must be perfectly empty)' },
        },
        {
          value: 'normal',
          label: { zh: '标准（容忍扫描噪点）', en: 'Normal (tolerates scanner noise)' },
        },
        {
          value: 'aggressive',
          label: { zh: '宽松（近乎空白也删，如只有页码）', en: 'Aggressive (near-blank too, e.g. lone page numbers)' },
        },
      ],
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const threshold = BLANK_THRESHOLDS[stringParam(ctx, 'sensitivity')] ?? 0.0002;

    const { kept, blank } = withDocumentSync(file.bytes, password, (doc) => {
      const total = doc.countPages();
      const keptPages: number[] = [];
      const blankPages: number[] = [];

      for (let page = 1; page <= total; page += 1) {
        checkCancelled(ctx);
        const ink = analyzePageInk(doc, page - 1);
        (ink.inkRatio <= threshold ? blankPages : keptPages).push(page);
        reportStep(ctx, page, total, {
          zh: `正在检查第 ${page}/${total} 页`,
          en: `Checking page ${page} of ${total}`,
        });
      }

      return { kept: keptPages, blank: blankPages };
    });

    if (blank.length === 0) {
      throw new ToolError('EMPTY_RESULT', 'No blank pages found', {
        zh: '没有发现空白页，文档保持原样。',
        en: 'No blank pages were found — the document is unchanged.',
      });
    }
    if (kept.length === 0) {
      throw new ToolError('EMPTY_RESULT', 'Every page is blank', {
        zh: '所有页面都是空白页，删除后将一无所剩。',
        en: 'Every page is blank; removing them would leave nothing.',
      });
    }

    const bytes = selectPages(file.bytes, password, kept, { garbage: 'compact' });
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(file.name, '_noblank', '.pdf'), bytes)],
      summary: {
        zh: `已删除第 ${formatPageRange(blank)} 页（共 ${blank.length} 个空白页），剩余 ${kept.length} 页`,
        en: `Removed ${blank.length} blank pages (${formatPageRange(blank)}); ${kept.length} remain`,
      },
    };
  },
};
