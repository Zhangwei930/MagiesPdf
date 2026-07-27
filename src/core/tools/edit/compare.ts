import type * as mupdf from 'mupdf';
import { ToolError } from '../../errors.ts';
import { openDocument } from '../../pdf/document.ts';
import type { ToolDescriptor } from '../../types.ts';
import type { ReportRow } from './getInfo.ts';
import { passwordParam, stringParam } from '../shared.ts';

/** Word-level difference between two texts, as multiset add/remove counts. */
export function wordDiff(before: string, after: string): { added: number; removed: number } {
  const count = (text: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const word of text.split(/\s+/).filter(Boolean)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return counts;
  };

  const beforeCounts = count(before);
  const afterCounts = count(after);

  let added = 0;
  for (const [word, n] of afterCounts) {
    added += Math.max(0, n - (beforeCounts.get(word) ?? 0));
  }
  let removed = 0;
  for (const [word, n] of beforeCounts) {
    removed += Math.max(0, n - (afterCounts.get(word) ?? 0));
  }
  return { added, removed };
}

function pageText(doc: mupdf.PDFDocument, pageIndex: number): string {
  return doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asText().trim();
}

export const compareTool: ToolDescriptor = {
  id: 'edit.compare',
  category: 'edit',
  name: { zh: '文档对比', en: 'Compare Documents' },
  description: {
    zh: '逐页对比两个 PDF 的文字内容，报告每页的差异量。',
    en: 'Compare two PDFs page by page and report how much text changed on each.',
  },
  icon: 'GitCompare',
  keywords: ['compare', 'diff', 'difference', 'versions', '对比', '比较', '差异', '版本'],
  input: { accept: ['.pdf'], min: 2, max: 2, ordered: true },
  output: 'report',
  params: [passwordParam()],
  runtime: 'worker',
  pipelineable: false,

  async run(ctx) {
    const [fileA, fileB] = ctx.files;
    if (!fileA || !fileB) {
      throw new ToolError('INVALID_INPUT', 'Compare needs exactly two PDFs', {
        zh: '需要两个 PDF：第一个作为基准，第二个作为对比对象。',
        en: 'Two PDFs are needed: the baseline first, the comparison second.',
      });
    }

    const password = stringParam(ctx, 'password');
    const docA = openDocument(fileA.bytes, password);
    const docB = openDocument(fileB.bytes, password);
    try {
      const pagesA = docA.countPages();
      const pagesB = docB.countPages();
      const common = Math.min(pagesA, pagesB);

      const rows: ReportRow[] = [
        { label: { zh: '基准文件', en: 'Baseline' }, value: `${fileA.name} (${pagesA} 页/pages)` },
        { label: { zh: '对比文件', en: 'Comparison' }, value: `${fileB.name} (${pagesB} 页/pages)` },
      ];

      let changedPages = 0;
      for (let page = 0; page < common; page += 1) {
        ctx.report(page / (common || 1));
        const textA = pageText(docA, page);
        const textB = pageText(docB, page);
        if (textA === textB) continue;

        changedPages += 1;
        const { added, removed } = wordDiff(textA, textB);
        rows.push({
          label: { zh: `第 ${page + 1} 页`, en: `Page ${page + 1}` },
          value: `+${added} / −${removed}`,
        });
      }

      if (pagesA !== pagesB) {
        rows.push({
          label: { zh: '页数差异', en: 'Page count' },
          value: `${pagesA} → ${pagesB}`,
        });
      }

      const identical = changedPages === 0 && pagesA === pagesB;
      if (identical) {
        rows.push({ label: { zh: '结论', en: 'Verdict' }, value: '=' });
      }

      ctx.report(1);
      return {
        files: [],
        data: rows,
        summary: identical
          ? { zh: '两个文档的文字内容完全一致', en: 'The two documents carry identical text' }
          : {
              zh: `${changedPages} 页有差异${pagesA !== pagesB ? `，页数不同（${pagesA} 对 ${pagesB}）` : ''}`,
              en: `${changedPages} pages differ${pagesA !== pagesB ? `; page counts differ (${pagesA} vs ${pagesB})` : ''}`,
            },
      };
    } finally {
      docA.destroy();
      docB.destroy();
    }
  },
};
