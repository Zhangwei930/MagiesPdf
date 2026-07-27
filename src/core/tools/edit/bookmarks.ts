import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument, withDocumentSync } from '../../pdf/document.ts';
import { parsePageRange } from '../../pageRange.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import type { ReportRow } from './getInfo.ts';
import { PDF_ONE, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

export interface BookmarkLine {
  /** 0 = top level, 1 = child. */
  level: number;
  title: string;
  /** 1-based page. */
  page: number;
}

/**
 * Parses the bookmark text format:
 *
 *   前言 | 1
 *   第一章 起步 | 3
 *     1.1 安装 | 4
 *     1.2 配置 | 7
 *   第二章 进阶 | 12
 *
 * One entry per line, `标题 | 页码`. Leading whitespace (two spaces or a tab)
 * marks a child of the previous top-level entry. Blank lines are ignored.
 */
export function parseBookmarkText(text: string, pageCount: number): BookmarkLine[] {
  const lines: BookmarkLine[] = [];

  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;

    const level = /^(\s+)/.test(raw) ? 1 : 0;
    const parts = raw.trim().split('|');
    if (parts.length < 2) {
      throw new ToolError('INVALID_PARAM', `Bookmark line ${index + 1} lacks a "| page" part`, {
        zh: `第 ${index + 1} 行缺少页码：每行的格式是「标题 | 页码」。`,
        en: `Line ${index + 1} is missing its page: each line is "Title | page".`,
      });
    }

    const title = parts.slice(0, -1).join('|').trim();
    const pageText = (parts.at(-1) as string).trim();
    const page = parsePageRange(pageText, pageCount)[0];
    if (title === '' || page === undefined) {
      throw new ToolError('INVALID_PARAM', `Bookmark line ${index + 1} is malformed`, {
        zh: `第 ${index + 1} 行无法解析。`,
        en: `Line ${index + 1} cannot be parsed.`,
      });
    }

    if (level === 1 && lines.length === 0) {
      throw new ToolError('INVALID_PARAM', 'First bookmark cannot be indented', {
        zh: '第一行不能缩进——子条目要跟在它所属的顶层条目后面。',
        en: 'The first line cannot be indented — children follow their top-level entry.',
      });
    }

    lines.push({ level, title, page });
  }

  return lines;
}

export const bookmarksTool: ToolDescriptor = {
  id: 'edit.bookmarks',
  category: 'edit',
  name: { zh: '书签目录', en: 'Bookmarks' },
  description: {
    zh: '查看、清空或用纯文本重建书签目录，支持两级层次。',
    en: 'List, clear, or rebuild the outline from plain text — two levels supported.',
  },
  icon: 'BookOpen',
  keywords: ['bookmark', 'outline', 'toc', 'contents', '书签', '目录', '大纲'],
  input: PDF_ONE,
  // "list" yields a report with no files; "set"/"clear" yield the modified PDF.
  output: 'report',
  pipelineable: false,
  params: [
    {
      key: 'action',
      type: 'select',
      label: { zh: '操作', en: 'Action' },
      default: 'list',
      options: [
        { value: 'list', label: { zh: '查看现有书签', en: 'List the current bookmarks' } },
        { value: 'set', label: { zh: '重建书签（覆盖现有）', en: 'Rebuild (replacing what exists)' } },
        { value: 'clear', label: { zh: '清空全部书签', en: 'Clear all bookmarks' } },
      ],
    },
    {
      key: 'entries',
      type: 'text',
      label: { zh: '书签内容', en: 'Bookmark entries' },
      help: {
        zh: '每行一条：「标题 | 页码」。行首缩进两格表示上一条的子书签。',
        en: 'One per line: "Title | page". Indent a line to make it a child of the previous top-level entry.',
      },
      placeholder: {
        zh: '前言 | 1\n第一章 | 3\n  1.1 小节 | 4',
        en: 'Preface | 1\nChapter One | 3\n  1.1 Section | 4',
      },
      default: '',
      multiline: true,
      required: true,
      visibleWhen: { key: 'action', equals: ['set'] },
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const password = stringParam(ctx, 'password');
    const action = stringParam(ctx, 'action');

    if (action === 'list') {
      return withDocumentSync(file.bytes, password, (doc) => {
        const outline = doc.loadOutline() ?? [];
        ctx.report(1);

        const rows: ReportRow[] = [];
        const walk = (
          items: ReadonlyArray<{ title?: string; page?: number; down?: unknown }>,
          depth: number,
        ): void => {
          for (const item of items) {
            rows.push({
              label: {
                zh: `${'　'.repeat(depth)}${item.title ?? '(无标题)'}`,
                en: `${'  '.repeat(depth)}${item.title ?? '(untitled)'}`,
              },
              value: item.page !== undefined ? `第 ${item.page + 1} 页 / p.${item.page + 1}` : '—',
            });
            if (Array.isArray(item.down)) walk(item.down, depth + 1);
          }
        };
        walk(outline, 0);

        return {
          files: [],
          data: rows,
          summary: {
            zh: rows.length > 0 ? `共 ${rows.length} 条书签` : '这个文档没有书签',
            en: rows.length > 0 ? `${rows.length} bookmarks` : 'This document has no bookmarks',
          },
        };
      });
    }

    const doc = openDocument(file.bytes, password);
    try {
      // Both "set" and "clear" start from an empty outline.
      const iterator = doc.outlineIterator();
      while (iterator.item()) iterator.delete();

      let written = 0;
      if (action === 'set') {
        const entries = parseBookmarkText(stringParam(ctx, 'entries'), doc.countPages());
        const uri = (page: number) =>
          doc.formatLinkURI({ page: page - 1, type: 'Fit', chapter: 0, x: 0, y: 0, width: 0, height: 0, zoom: 0 });

        for (let i = 0; i < entries.length; ) {
          const entry = entries[i] as BookmarkLine;
          iterator.insert({ title: entry.title, uri: uri(entry.page), open: false });
          written += 1;
          i += 1;

          // Children of this entry: step back onto it, descend, insert, resurface.
          if (i < entries.length && (entries[i] as BookmarkLine).level === 1) {
            iterator.prev();
            iterator.down();
            while (i < entries.length && (entries[i] as BookmarkLine).level === 1) {
              const child = entries[i] as BookmarkLine;
              iterator.insert({ title: child.title, uri: uri(child.page), open: false });
              written += 1;
              i += 1;
            }
            iterator.up();
            iterator.next();
          }
        }

        if (written === 0) {
          throw new ToolError('INVALID_PARAM', 'No bookmark entries parsed', {
            zh: '书签内容是空的，请至少填写一行。',
            en: 'The bookmark text is empty — add at least one line.',
          });
        }
      }

      const bytes = saveDocument(doc, { garbage: 'compact' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, action === 'clear' ? '_nobookmarks' : '_bookmarked', '.pdf'), bytes)],
        summary:
          action === 'clear'
            ? { zh: '已清空全部书签', en: 'All bookmarks removed' }
            : { zh: `已写入 ${written} 条书签`, en: `Wrote ${written} bookmarks` },
      };
    } finally {
      doc.destroy();
    }
  },
};
