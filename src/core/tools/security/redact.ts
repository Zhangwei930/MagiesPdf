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

/**
 * A rectangle to black out, in PDF points on a top-left origin — the space
 * MuPDF's annotation rects use, and the one a rendered page maps onto directly.
 */
export interface RedactRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function invalidRegions(detail: string): ToolError {
  return new ToolError('INVALID_PARAM', `Invalid redaction regions: ${detail}`, {
    zh: '选区数据无效，请重新框选。',
    en: 'The selection data was invalid — draw the box again.',
  });
}

/** Parses the region list the viewer sends as JSON. Blank means "no regions". */
export function parseRegions(text: string): RedactRegion[] {
  if (text.trim() === '') return [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalidRegions('not valid JSON');
  }
  if (!Array.isArray(raw)) throw invalidRegions('expected an array');

  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw invalidRegions(`entry ${index} is not an object`);
    }
    const region = entry as Record<string, unknown>;
    for (const key of ['page', 'x', 'y', 'width', 'height'] as const) {
      if (typeof region[key] !== 'number' || !Number.isFinite(region[key])) {
        throw invalidRegions(`entry ${index} has no finite "${key}"`);
      }
    }
    const parsed = region as unknown as RedactRegion;
    if (!Number.isInteger(parsed.page) || parsed.page < 1) {
      throw invalidRegions(`entry ${index} has page ${parsed.page}`);
    }
    if (parsed.width <= 0 || parsed.height <= 0) {
      throw invalidRegions(`entry ${index} has zero area`);
    }
    return {
      page: parsed.page,
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height,
    };
  });
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
      required: false,
    },
    {
      key: 'regions',
      type: 'text',
      label: { zh: '选区（JSON）', en: 'Regions (JSON)' },
      help: {
        zh: '一般由预览界面框选自动填写。格式：[{"page":1,"x":0,"y":0,"width":100,"height":20}]，单位为磅、原点在页面左上角。',
        en: 'Normally filled in by dragging a box in the preview. Format: [{"page":1,"x":0,"y":0,"width":100,"height":20}] — points, origin at the page top-left.',
      },
      default: '',
      multiline: true,
      advanced: true,
    },
    {
      key: 'pages',
      type: 'pageRange',
      label: { zh: '页码范围', en: 'Pages' },
      help: {
        zh: '只影响关键词搜索的范围；选区自带页码。',
        en: 'Scopes the keyword search only — regions carry their own page number.',
      },
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
    const regions = parseRegions(stringParam(ctx, 'regions'));
    if (keywords.length === 0 && regions.length === 0) {
      throw new ToolError('INVALID_PARAM', 'No keywords or regions provided', {
        zh: '请填写要涂黑的关键词，或在预览里框选一块区域。',
        en: 'Provide a keyword to redact, or drag a box over the area in the preview.',
      });
    }

    const caseSensitive = boolParam(ctx, 'caseSensitive');
    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));

    try {
      const pageCount = doc.countPages();
      const beyond = regions.find((region) => region.page > pageCount);
      if (beyond) {
        throw new ToolError('INVALID_PARAM', `Region page ${beyond.page} is past the last page`, {
          zh: `选区指向第 ${beyond.page} 页，但文档只有 ${pageCount} 页。`,
          en: `A selection points at page ${beyond.page}, but the document has ${pageCount}.`,
        });
      }

      // Regions carry their own page number, independent of the keyword page
      // range, so they get their own pass.
      for (const region of regions) {
        const page = doc.loadPage(region.page - 1);
        const annot = page.createAnnotation('Redact');
        annot.setRect([region.x, region.y, region.x + region.width, region.y + region.height]);
        annot.update();
        page.applyRedactions();
      }

      let keywordHits = 0;

      if (keywords.length > 0) {
        const pages = resolvePages(ctx, 'pages', pageCount);

        for (let step = 0; step < pages.length; step += 1) {
          const pageIndex = (pages[step] as number) - 1;
          const page = doc.loadPage(pageIndex);

          for (const keyword of keywords) {
            // MuPDF's search is case-sensitive; for insensitive mode we search
            // the structured text ourselves and only fall back to page.search
            // for the precise quads of each exact-case occurrence found.
            const targets = caseSensitive ? [keyword] : uniqueCaseVariants(page, keyword);

            for (const target of targets) {
              // page.search returns Quad[][] — each match is a list of 8-number quads.
              const hits = page.search(target);
              for (const match of hits) {
                for (const quad of match) {
                  const annot = page.createAnnotation('Redact');
                  annot.setQuadPoints([quad]);
                  annot.update();
                  keywordHits += 1;
                }
              }
            }
          }

          page.applyRedactions();
          reportStep(ctx, step + 1, pages.length);
        }

        // A region always redacts what it covers, so an empty result is only a
        // failure when keywords were the sole instruction.
        if (keywordHits === 0 && regions.length === 0) {
          throw new ToolError('EMPTY_RESULT', 'No matches to redact', {
            zh: '没有找到匹配的关键词，未做任何涂黑。',
            en: 'No matching keywords found — nothing was redacted.',
          });
        }
      }

      const bytes = saveDocument(doc, { garbage: 'deduplicate' });
      ctx.report(1);

      const parts = {
        zh: [
          regions.length > 0 ? `${regions.length} 个选区` : '',
          keywords.length > 0 ? `${keywordHits} 处关键词匹配` : '',
        ].filter(Boolean),
        en: [
          regions.length > 0 ? `${regions.length} region(s)` : '',
          keywords.length > 0 ? `${keywordHits} keyword match(es)` : '',
        ].filter(Boolean),
      };

      return {
        files: [pdfOutput(suffixedName(file.name, '_redacted', '.pdf'), bytes)],
        summary: {
          zh: `已涂黑 ${parts.zh.join('、')}`,
          en: `Redacted ${parts.en.join(' and ')}`,
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
