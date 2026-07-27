import { ToolError } from '../../errors.ts';
import { selectPages } from '../../pdf/assemble.ts';
import { withDocumentSync } from '../../pdf/document.ts';
import { sanitizeFileName, stemOf } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  boolParam,
  checkCancelled,
  passwordParam,
  pdfOutput,
  reportStep,
  soleFile,
  stringParam,
} from '../shared.ts';

export interface Chapter {
  title: string;
  /** 1-based inclusive range. */
  from: number;
  to: number;
}

/**
 * Converts top-level outline entries into contiguous chapters.
 *
 * Entries without a resolvable page are skipped; entries pointing at the same
 * page merge (the later title wins the next range). Pages before the first
 * chapter become a synthetic front-matter chapter.
 */
export function chaptersFromOutline(
  outline: ReadonlyArray<{ title?: string; page?: number }> | null,
  pageCount: number,
): Chapter[] {
  const anchors = (outline ?? [])
    .filter((entry): entry is { title?: string; page: number } =>
      typeof entry.page === 'number' && entry.page >= 0 && entry.page < pageCount,
    )
    .map((entry, index) => ({ title: entry.title?.trim() || `Chapter ${index + 1}`, page: entry.page }))
    .sort((a, b) => a.page - b.page);

  if (anchors.length === 0) return [];

  const chapters: Chapter[] = [];
  const firstAnchor = anchors[0] as { title: string; page: number };
  if (firstAnchor.page > 0) {
    chapters.push({ title: 'Front matter', from: 1, to: firstAnchor.page });
  }

  for (let i = 0; i < anchors.length; i += 1) {
    const current = anchors[i] as { title: string; page: number };
    const next = anchors[i + 1];
    const from = current.page + 1;
    const to = next ? next.page : pageCount;
    // Two bookmarks on one page: the earlier one would span zero pages — skip it.
    if (to < from) continue;
    chapters.push({ title: current.title, from, to });
  }

  return chapters;
}

export const splitByChaptersTool: ToolDescriptor = {
  id: 'organize.split-by-chapters',
  category: 'organize',
  name: { zh: '按章节拆分', en: 'Split by Chapters' },
  description: {
    zh: '沿书签目录的顶层章节把文档拆成多个文件，文件名取自章节标题。',
    en: 'Split along the outline’s top-level chapters, naming each file after its bookmark.',
  },
  icon: 'BookOpen',
  keywords: ['chapter', 'bookmark', 'outline', 'toc', 'split', '章节', '书签', '目录', '拆分'],
  input: PDF_ONE,
  output: 'multiple',
  params: [
    {
      key: 'includeFrontMatter',
      type: 'boolean',
      label: { zh: '第一章之前的页面单独成文件', en: 'Keep pages before the first chapter as their own file' },
      help: {
        zh: '不勾选则丢弃封面、目录等前置页。',
        en: 'Unticked, cover pages and tables of contents before chapter one are dropped.',
      },
      default: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const includeFrontMatter = boolParam(ctx, 'includeFrontMatter');

    const chapters = withDocumentSync(file.bytes, password, (doc) =>
      chaptersFromOutline(doc.loadOutline(), doc.countPages()),
    );

    if (chapters.length === 0) {
      throw new ToolError('INVALID_INPUT', 'Document has no usable outline', {
        zh: '这个文档没有书签目录，无法按章节拆分。可以改用「拆分 PDF」按页数拆。',
        en: 'This document has no outline to split along. Try Split PDF with page counts instead.',
      });
    }

    const selected = chapters.filter(
      (chapter) => includeFrontMatter || chapter.title !== 'Front matter',
    );

    const stem = stemOf(file.name);
    const files = selected.map((chapter, index) => {
      checkCancelled(ctx);
      const pages = Array.from(
        { length: chapter.to - chapter.from + 1 },
        (_, i) => chapter.from + i,
      );
      const bytes = selectPages(file.bytes, password, pages, { garbage: 'compact' });
      reportStep(ctx, index + 1, selected.length, {
        zh: `正在写出「${chapter.title}」`,
        en: `Writing "${chapter.title}"`,
      });
      const ordinal = String(index + 1).padStart(String(selected.length).length, '0');
      return pdfOutput(sanitizeFileName(`${stem}_${ordinal}_${chapter.title}.pdf`), bytes);
    });

    ctx.report(1);
    return {
      files,
      summary: {
        zh: `已按 ${selected.length} 个章节拆分`,
        en: `Split into ${selected.length} chapters`,
      },
    };
  },
};
