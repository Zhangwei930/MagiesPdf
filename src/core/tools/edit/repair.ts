import { openDocument, saveDocument } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

export const repairTool: ToolDescriptor = {
  id: 'edit.repair',
  category: 'edit',
  name: { zh: '修复 PDF', en: 'Repair PDF' },
  description: {
    zh: '重建损坏的交叉引用表和文档结构，让打不开的 PDF 恢复可读。',
    en: 'Rebuild a damaged cross-reference table and structure so a broken PDF opens again.',
  },
  icon: 'Wrench',
  keywords: ['repair', 'fix', 'recover', 'broken', 'corrupt', '修复', '恢复', '损坏', '打不开'],
  input: PDF_ONE,
  output: 'single',
  params: [passwordParam()],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);

    // MuPDF's parser already repairs on open — it scans for objects when the
    // xref is unusable. The tool's work is that tolerant parse plus a clean,
    // fully rewritten save. A file too broken even for the scan is unrecoverable.
    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const pageCount = doc.countPages();
      const bytes = saveDocument(doc, { garbage: 'deduplicate', clean: true });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_repaired', '.pdf'), bytes)],
        summary: {
          zh: `已重建文档结构，恢复 ${pageCount} 页`,
          en: `Rebuilt the document structure — ${pageCount} pages recovered`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
