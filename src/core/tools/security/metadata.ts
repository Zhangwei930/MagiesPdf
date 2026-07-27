import { openDocument, saveDocument } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { TextParam, ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

/** The Info-dictionary fields exposed for editing, in display order. */
export const EDITABLE_FIELDS = [
  { param: 'title', key: 'info:Title', label: { zh: '标题', en: 'Title' } },
  { param: 'author', key: 'info:Author', label: { zh: '作者', en: 'Author' } },
  { param: 'subject', key: 'info:Subject', label: { zh: '主题', en: 'Subject' } },
  { param: 'keywords', key: 'info:Keywords', label: { zh: '关键词', en: 'Keywords' } },
  { param: 'creator', key: 'info:Creator', label: { zh: '创建程序', en: 'Creator' } },
  { param: 'producer', key: 'info:Producer', label: { zh: '生成器', en: 'Producer' } },
] as const;

function fieldParams(): TextParam[] {
  return EDITABLE_FIELDS.map((field) => ({
    key: field.param,
    type: 'text' as const,
    label: field.label,
    default: '',
    maxLength: 500,
  }));
}

export const editMetadataTool: ToolDescriptor = {
  id: 'security.edit-metadata',
  category: 'security',
  name: { zh: '编辑元数据', en: 'Edit Metadata' },
  description: {
    zh: '修改标题、作者、关键词等文档属性。',
    en: 'Change the document properties — title, author, keywords and more.',
  },
  icon: 'FilePenLine',
  keywords: ['metadata', 'properties', 'title', 'author', '元数据', '属性', '标题', '作者'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'mode',
      type: 'select',
      label: { zh: '写入方式', en: 'Write mode' },
      default: 'update',
      options: [
        {
          value: 'update',
          label: { zh: '只更新填写的字段', en: 'Update only the filled-in fields' },
        },
        {
          value: 'replace',
          label: { zh: '完全替换（留空的字段会被清除）', en: 'Replace everything (empty fields are cleared)' },
        },
      ],
    },
    ...fieldParams(),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const replaceAll = stringParam(ctx, 'mode') === 'replace';

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      let touched = 0;
      for (const field of EDITABLE_FIELDS) {
        const value = stringParam(ctx, field.param);
        if (value === '' && !replaceAll) continue;
        doc.setMetaData(field.key, value);
        touched += 1;
      }

      const bytes = saveDocument(doc, { garbage: 'compact' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_meta', '.pdf'), bytes)],
        summary: {
          zh: `已${replaceAll ? '替换' : '更新'} ${touched} 个元数据字段`,
          en: `${replaceAll ? 'Replaced' : 'Updated'} ${touched} metadata fields`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};

export const removeMetadataTool: ToolDescriptor = {
  id: 'security.remove-metadata',
  category: 'security',
  name: { zh: '清除元数据', en: 'Remove Metadata' },
  description: {
    zh: '抹掉全部文档属性和 XMP 元数据——分享文件前的隐私清理。',
    en: 'Strip the Info dictionary and XMP metadata — privacy hygiene before sharing a file.',
  },
  icon: 'Eraser',
  keywords: ['metadata', 'privacy', 'strip', 'clean', 'anonymous', '隐私', '清除', '匿名'],
  input: PDF_ONE,
  output: 'single',
  params: [passwordParam()],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      // Belt and braces: clear the values MuPDF knows about, then drop the whole
      // Info dictionary and the XMP stream so nothing survives in either store.
      for (const field of EDITABLE_FIELDS) doc.setMetaData(field.key, '');
      doc.setMetaData('info:CreationDate', '');
      doc.setMetaData('info:ModDate', '');

      const trailer = doc.getTrailer();
      trailer.delete('Info');
      const root = trailer.get('Root');
      if (root && !root.isNull()) root.delete('Metadata');

      const bytes = saveDocument(doc, { garbage: 'deduplicate' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_clean', '.pdf'), bytes)],
        summary: {
          zh: '已清除全部元数据（文档属性与 XMP）',
          en: 'All metadata removed (Info dictionary and XMP)',
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
