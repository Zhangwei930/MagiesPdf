import { rotateDocumentPages } from '../../pdf/assemble.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { formatPageRange } from '../../pageRange.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  numberParam,
  pageRangeParam,
  passwordParam,
  pdfOutput,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

export const rotateTool: ToolDescriptor = {
  id: 'organize.rotate',
  category: 'organize',
  name: { zh: '旋转页面', en: 'Rotate Pages' },
  description: {
    zh: '把选中的页面旋转 90°、180° 或 270°，适合修正扫描方向。',
    en: 'Turn selected pages by 90°, 180° or 270° — handy for fixing scan orientation.',
  },
  icon: 'RotateCw',
  keywords: ['rotate', 'turn', 'orientation', 'landscape', '旋转', '转向', '方向'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'degrees',
      type: 'select',
      label: { zh: '旋转角度', en: 'Rotation' },
      default: '90',
      options: [
        { value: '90', label: { zh: '顺时针 90°', en: '90° clockwise' } },
        { value: '180', label: { zh: '180°', en: '180°' } },
        { value: '270', label: { zh: '逆时针 90°', en: '90° counter-clockwise' } },
      ],
    },
    {
      key: 'mode',
      type: 'select',
      label: { zh: '应用方式', en: 'Apply as' },
      default: 'add',
      options: [
        {
          value: 'add',
          label: { zh: '在当前方向上继续旋转', en: 'Add to the current rotation' },
        },
        {
          value: 'set',
          label: { zh: '设为绝对方向', en: 'Set as the absolute rotation' },
          help: {
            zh: '忽略页面已有的旋转值，统一设定方向。',
            en: 'Ignores any rotation the page already has and sets it outright.',
          },
        },
      ],
      advanced: true,
    },
    pageRangeParam({ label: { zh: '要旋转的页', en: 'Pages to rotate' }, default: 'all' }),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const mode = stringParam(ctx, 'mode') === 'set' ? 'set' : 'add';
    const degrees = numberParam(ctx, 'degrees');

    const doc = openDocument(file.bytes, password);
    try {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      rotateDocumentPages(doc, pages, degrees, mode);
      const bytes = saveDocument(doc, { garbage: 'compact' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_rotated', '.pdf'), bytes)],
        summary: {
          zh: `已将第 ${formatPageRange(pages)} 页旋转 ${degrees}°`,
          en: `Rotated pages ${formatPageRange(pages)} by ${degrees}°`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
