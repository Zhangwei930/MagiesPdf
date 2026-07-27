import type * as mupdf from 'mupdf';
import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  boolParam,
  passwordParam,
  pdfOutput,
  reportStep,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

/** One search term per non-empty line; `#` comments allowed. */
export function parseKeywords(text: string): string[] {
  const terms: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    terms.push(line);
  }
  return terms;
}

export const redactTool: ToolDescriptor = {
  id: 'security.redact',
  category: 'security',
  name: { zh: '涂黑敏感内容', en: 'Redact' },
  description: {
    zh: '按关键词搜索并永久涂黑删除文字（不可恢复）。适合去敏身份证号、电话、姓名等。',
    en: 'Search for keywords and permanently black out the matching text. Irreversible — use for IDs, phones, names.',
  },
  icon: 'Eraser',
  keywords: ['redact', 'blackout', 'censor', 'sensitive', 'pii', '涂黑', '脱敏', '删除', '打码'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'keywords',
      type: 'text',
      label: { zh: '关键词', en: 'Keywords' },
      help: {
        zh: '每行一个关键词。匹配到的文字会被永久删除并涂黑。',
        en: 'One keyword per line. Matching text is permanently removed and blacked out.',
      },
      default: '',
      multiline: true,
      required: true,
    },
    {
      key: 'pages',
      type: 'pageRange',
      label: { zh: '页码范围', en: 'Pages' },
      default: 'all',
      required: true,
    },
    {
      key: 'caseSensitive',
      type: 'boolean',
      label: { zh: '区分大小写', en: 'Case sensitive' },
      default: false,
      advanced: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const keywords = parseKeywords(stringParam(ctx, 'keywords'));
    if (keywords.length === 0) {
      throw new ToolError('INVALID_PARAM', 'No keywords provided', {
        zh: '请至少填写一个要涂黑的关键词。',
        en: 'Provide at least one keyword to redact.',
      });
    }

    const caseSensitive = boolParam(ctx, 'caseSensitive');
    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));

    try {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      let matchCount = 0;

      for (let step = 0; step < pages.length; step += 1) {
        const pageIndex = (pages[step] as number) - 1;
        const page = doc.loadPage(pageIndex);

        for (const keyword of keywords) {
          // MuPDF's search is case-sensitive; for insensitive mode we search
          // the structured text ourselves and only fall back to page.search
          // for the precise quads of each exact-case occurrence found.
          const targets = caseSensitive
            ? [keyword]
            : uniqueCaseVariants(page, keyword);

          for (const target of targets) {
            // page.search returns Quad[][] — each match is a list of 8-number quads.
            const hits = page.search(target);
            for (const match of hits) {
              for (const quad of match) {
                const annot = page.createAnnotation('Redact');
                annot.setQuadPoints([quad]);
                annot.update();
                matchCount += 1;
              }
            }
          }
        }

        page.applyRedactions();
        reportStep(ctx, step + 1, pages.length);
      }

      if (matchCount === 0) {
        throw new ToolError('EMPTY_RESULT', 'No matches to redact', {
          zh: '没有找到匹配的关键词，未做任何涂黑。',
          en: 'No matching keywords found — nothing was redacted.',
        });
      }

      const bytes = saveDocument(doc, { garbage: 'deduplicate' });

      return {
        files: [pdfOutput(suffixedName(file.name, '_redacted', '.pdf'), bytes)],
        summary: {
          zh: `已涂黑 ${matchCount} 处（${keywords.length} 个关键词）`,
          en: `Redacted ${matchCount} match(es) across ${keywords.length} keyword(s)`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};

/**
 * Find every case-variant of `keyword` that actually appears on the page so
 * MuPDF's case-sensitive search can still hit them.
 */
function uniqueCaseVariants(page: mupdf.PDFPage, keyword: string): string[] {
  const needle = keyword.toLowerCase();
  if (needle === '') return [];

  const structured = JSON.parse(
    page.toStructuredText('preserve-whitespace').asJSON(),
  ) as { blocks: Array<{ type: string; lines: Array<{ text: string }> }> };

  const found = new Set<string>();
  for (const block of structured.blocks) {
    if (block.type !== 'text') continue;
    for (const line of block.lines) {
      const text = line.text;
      const lower = text.toLowerCase();
      let from = 0;
      while (from < lower.length) {
        const at = lower.indexOf(needle, from);
        if (at === -1) break;
        found.add(text.slice(at, at + keyword.length));
        from = at + 1;
      }
    }
  }
  return [...found];
}
