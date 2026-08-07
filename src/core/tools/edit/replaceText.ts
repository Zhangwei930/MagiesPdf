import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
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

/**
 * Changing words that are already in a PDF.
 *
 * A PDF holds positioned glyphs, not sentences, so this is not editing in the
 * sense a word processor means: the old glyphs are redacted away and the new
 * ones are drawn where they stood. That is enough for the thing people actually
 * ask for — a wrong date, a stale company name, a "Draft" that should not have
 * shipped — and it is honest about the rest, which the description states
 * rather than discovering for the user:
 *
 * - the replacement is drawn in a standard font, so a distinctive typeface will
 *   not match
 * - nothing reflows, so a longer replacement runs on rather than pushing the
 *   text after it along
 * - only Latin text can be drawn at all, because the standard fonts cannot
 *   encode anything else
 */

export interface Replacement {
  find: string;
  replace: string;
}

/**
 * WinAnsi is what pdf-lib's standard fonts can encode; anything else is refused.
 *
 * Written with escapes because the range covers a non-breaking space, which no
 * reader could tell from an ordinary one in the source.
 */
const DRAWABLE = /^[\u0020-\u007e\u00a0-\u00ff\u2018\u2019\u201c\u201d\u2013\u2014\u2022]*$/;

export function parseReplacements(text: string): Replacement[] {
  const pairs: Replacement[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new ToolError('INVALID_PARAM', `Each line must be find=replace, got: ${line}`, {
        zh: `每行应为 原文=新文，无法解析：${line}`,
        en: `Each line must be find=replace; could not parse: ${line}`,
      });
    }
    const replace = line.slice(separator + 1);
    if (!DRAWABLE.test(replace)) {
      // Drawing this would either produce empty boxes or throw from inside the
      // encoder, and either way the old text is already gone by then.
      throw new ToolError('INVALID_PARAM', `Replacement text must be Latin: ${replace}`, {
        zh: `替换文字目前只支持拉丁字符（标准字体无法编码中文）：${replace}`,
        en: `Replacement text must be Latin — the standard fonts cannot encode: ${replace}`,
      });
    }
    pairs.push({ find: line.slice(0, separator).trim(), replace });
  }
  return pairs;
}

interface Hit {
  page: number;
  /** PDF user space, origin bottom-left. */
  x: number;
  baseline: number;
  height: number;
  replace: string;
}

export const replaceTextTool: ToolDescriptor = {
  id: 'edit.replace-text',
  category: 'edit',
  name: { zh: '替换 PDF 文字', en: 'Replace Text' },
  description: {
    zh: '把 PDF 里已有的文字换成新的：原字被彻底移除，新字画在原位。'
      + '不会重排，新文字过长会压到后面；使用标准字体，无法匹配原有字体；暂不支持中文替换文字。',
    en: 'Replace words already in a PDF. The old glyphs are removed and the new ones drawn in '
      + 'their place. Nothing reflows, the replacement uses a standard font rather than the '
      + "original's, and only Latin replacement text can be drawn.",
  },
  icon: 'FilePenLine',
  keywords: ['replace', 'edit text', 'change', '替换', '改字', '编辑文字'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'replacements',
      type: 'text',
      label: { zh: '替换内容', en: 'Replacements' },
      help: {
        zh: '每行一个：原文=新文。新文留空表示删除原文。以 # 开头的行是注释。',
        en: 'One per line: find=replace. An empty replacement deletes the phrase. '
          + 'Lines starting with # are comments.',
      },
      default: '',
      multiline: true,
    },
    pageRangeParam(),
    {
      key: 'size',
      type: 'number',
      label: { zh: '字号', en: 'Font size' },
      help: {
        zh: '0 表示按原文高度推算。',
        en: 'Zero measures it from the height of the text being replaced.',
      },
      default: 0,
      min: 0,
      max: 200,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const replacements = parseReplacements(stringParam(ctx, 'replacements'));
    if (replacements.length === 0) {
      throw new ToolError('INVALID_PARAM', 'Describe at least one replacement', {
        zh: '请至少写一条替换',
        en: 'Describe at least one replacement',
      });
    }
    const explicitSize = numberParam(ctx, 'size');

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    const hits: Hit[] = [];
    let redacted: Uint8Array;

    try {
      const targets = resolvePages(ctx, 'pages', doc.countPages());
      for (const pageNumber of targets) {
        const page = doc.loadPage(pageNumber - 1);
        // MuPDF measures from the top of the page; pdf-lib from the bottom.
        const bounds = page.getBounds();
        const pageHeight = bounds[3] - bounds[1];

        for (const { find, replace } of replacements) {
          for (const match of page.search(find)) {
            for (const quad of match) {
              const [upperLeftX, upperLeftY, , , , lowerLeftY] = quad;
              hits.push({
                page: pageNumber - 1,
                x: upperLeftX,
                baseline: pageHeight - lowerLeftY,
                height: Math.abs(lowerLeftY - upperLeftY),
                replace,
              });
              const annotation = page.createAnnotation('Redact');
              annotation.setQuadPoints([quad]);
              annotation.update();
            }
          }
        }
        // Redaction takes the glyphs out of the content stream, where covering
        // them with a white rectangle would leave text any reader could select.
        // Without `false` it also paints the censor's black box over the gap,
        // and the replacement would be drawn underneath it.
        page.applyRedactions(false);
      }

      if (hits.length === 0) {
        throw new ToolError('EMPTY_RESULT', 'No matches to replace', {
          zh: '没有找到要替换的文字',
          en: 'No matches to replace',
        });
      }
      redacted = saveDocument(doc);
    } finally {
      doc.destroy();
    }

    const rewritten = await PDFDocument.load(redacted);
    const font = await rewritten.embedFont(StandardFonts.Helvetica);
    const pages = rewritten.getPages();
    for (const hit of hits) {
      if (hit.replace === '') continue;
      const page = pages[hit.page];
      if (!page) continue;
      // A quad is the glyph box, which sits a little above the baseline.
      const size = explicitSize > 0 ? explicitSize : Math.max(hit.height * 0.8, 4);
      page.drawText(hit.replace, {
        x: hit.x,
        y: hit.baseline + hit.height * 0.2,
        size,
        font,
        color: rgb(0, 0, 0),
      });
    }

    ctx.report(1);
    return {
      files: [pdfOutput(suffixedName(file.name, 'edited'), await rewritten.save())],
      summary: {
        zh: `已替换 ${hits.length} 处`,
        en: `Replaced ${hits.length} ${hits.length === 1 ? 'occurrence' : 'occurrences'}`,
      },
    };
  },
};
