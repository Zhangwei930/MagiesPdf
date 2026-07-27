import { openDocument, saveDocument } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, boolParam, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

export const flattenTool: ToolDescriptor = {
  id: 'security.flatten',
  category: 'security',
  name: { zh: '扁平化表单', en: 'Flatten Forms' },
  description: {
    zh: '把表单里填写的内容烙进页面，变成不可再编辑的普通文字。',
    en: 'Bake filled-in form values into the page as plain, no-longer-editable content.',
  },
  icon: 'Layers',
  keywords: ['flatten', 'form', 'bake', 'lock', 'acroform', '扁平化', '表单', '锁定', '固化'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'annotations',
      type: 'boolean',
      label: { zh: '同时扁平化批注', en: 'Also flatten annotations' },
      help: {
        zh: '把高亮、注释等批注一并画入页面内容。',
        en: 'Draws highlights, notes and other annotations into the page content too.',
      },
      default: false,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      // Count first — bake() removes the widgets it flattens.
      let widgetCount = 0;
      const pageCount = doc.countPages();
      for (let i = 0; i < pageCount; i += 1) {
        widgetCount += doc.loadPage(i).getWidgets().length;
      }

      doc.bake(boolParam(ctx, 'annotations'), true);

      const bytes = saveDocument(doc, { garbage: 'deduplicate' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_flat', '.pdf'), bytes)],
        summary: {
          zh: widgetCount > 0 ? `已固化 ${widgetCount} 个表单域` : '文档中没有表单域，已按原样输出',
          en:
            widgetCount > 0
              ? `Baked ${widgetCount} form fields into the page`
              : 'No form fields found — output is the document as-is',
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
