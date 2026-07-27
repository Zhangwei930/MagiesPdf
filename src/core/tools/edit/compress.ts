import { openDocument, saveDocument } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

export const compressTool: ToolDescriptor = {
  id: 'edit.compress',
  category: 'edit',
  name: { zh: '压缩 PDF', en: 'Compress PDF' },
  description: {
    zh: '清理冗余对象、重压缩数据流，减小文件体积。内容与画质保持不变。',
    en: 'Strip redundant objects and recompress streams for a smaller file. Content and quality stay intact.',
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
      default: 'standard',
      options: [
        {
          value: 'standard',
          label: { zh: '标准（快速）', en: 'Standard (fast)' },
          help: { zh: '合并重复对象并压缩数据流。', en: 'Merge duplicates and compress streams.' },
        },
        {
          value: 'aggressive',
          label: { zh: '强力', en: 'Aggressive' },
          help: {
            zh: '额外重压缩图片与字体数据流，并清理无效结构。',
            en: 'Also recompress image and font streams, and clean broken structure.',
          },
        },
      ],
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const aggressive = stringParam(ctx, 'level') === 'aggressive';

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const bytes = saveDocument(doc, {
        garbage: 'deduplicate',
        compress: true,
        compressImages: aggressive,
        compressFonts: aggressive,
        clean: aggressive,
      });
      ctx.report(1);

      const before = file.bytes.length;
      const after = bytes.length;
      const saved = Math.max(0, before - after);
      const percent = before > 0 ? Math.round((saved / before) * 100) : 0;

      return {
        files: [pdfOutput(suffixedName(file.name, '_compressed', '.pdf'), bytes)],
        summary:
          saved > 0
            ? {
                zh: `体积减小 ${percent}%（${formatKb(before)} → ${formatKb(after)}）`,
                en: `${percent}% smaller (${formatKb(before)} → ${formatKb(after)})`,
              }
            : {
                zh: '文件已经很紧凑，没有可压缩的空间',
                en: 'The file was already compact — nothing left to squeeze',
              },
      };
    } finally {
      doc.destroy();
    }
  },
};

function formatKb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
