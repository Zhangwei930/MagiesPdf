import type * as mupdf from 'mupdf';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, listParam, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

/**
 * Document sanitisation: stripping the parts of a PDF that can act rather than
 * display — scripts, auto-run actions, embedded payloads, outbound links.
 *
 * The detectors are exported so tests can assert on real documents and a future
 * "show JavaScript" tool can reuse them.
 */

function root(doc: mupdf.PDFDocument): mupdf.PDFObject | null {
  const r = doc.getTrailer().get('Root');
  return r && !r.isNull() ? r : null;
}

function names(doc: mupdf.PDFDocument): mupdf.PDFObject | null {
  const n = root(doc)?.get('Names');
  return n && !n.isNull() ? n : null;
}

/** Entries in a name tree (flat /Names arrays, recursing into /Kids). */
function countNameTree(tree: mupdf.PDFObject | null | undefined): number {
  if (!tree || tree.isNull()) return 0;
  let count = 0;
  const flat = tree.get('Names');
  if (flat && !flat.isNull() && flat.isArray()) count += Math.floor(flat.length / 2);
  const kids = tree.get('Kids');
  if (kids && !kids.isNull() && kids.isArray()) {
    for (let i = 0; i < kids.length; i += 1) count += countNameTree(kids.get(i));
  }
  return count;
}

/** All annotation dictionaries of a page. */
function pageAnnotations(doc: mupdf.PDFDocument, pageIndex: number): mupdf.PDFObject[] {
  const annots = doc.loadPage(pageIndex).getObject().get('Annots');
  if (!annots || annots.isNull() || !annots.isArray()) return [];
  const list: mupdf.PDFObject[] = [];
  for (let i = 0; i < annots.length; i += 1) list.push(annots.get(i));
  return list;
}

function actionType(annotation: mupdf.PDFObject): string {
  const action = annotation.get('A');
  if (!action || action.isNull()) return '';
  return String(action.get('S'));
}

export interface FoundScript {
  /** Where the script hangs: 'open-action', 'named', or 'annotation'. */
  location: string;
  source: string;
}

/** The /JS value may be a literal string or a stream; read either. */
function scriptSource(action: mupdf.PDFObject): string {
  const js = action.get('JS');
  if (!js || js.isNull()) return '';
  if (js.isStream()) {
    const buffer = js.readStream();
    return new TextDecoder().decode(buffer.asUint8Array());
  }
  return js.asString();
}

/** Every script in the document, with its source — powers the Show JavaScript tool. */
export function collectJavaScript(doc: mupdf.PDFDocument): FoundScript[] {
  const scripts: FoundScript[] = [];

  const openAction = root(doc)?.get('OpenAction');
  if (openAction && !openAction.isNull() && String(openAction.get('S')) === '/JavaScript') {
    scripts.push({ location: 'open-action', source: scriptSource(openAction) });
  }

  const walkTree = (tree: mupdf.PDFObject | null | undefined): void => {
    if (!tree || tree.isNull()) return;
    const flat = tree.get('Names');
    if (flat && !flat.isNull() && flat.isArray()) {
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const name = flat.get(i).asString();
        const action = flat.get(i + 1);
        if (action && !action.isNull()) {
          scripts.push({ location: `named: ${name}`, source: scriptSource(action) });
        }
      }
    }
    const kids = tree.get('Kids');
    if (kids && !kids.isNull() && kids.isArray()) {
      for (let i = 0; i < kids.length; i += 1) walkTree(kids.get(i));
    }
  };
  walkTree(names(doc)?.get('JavaScript'));

  const pageCount = doc.countPages();
  for (let i = 0; i < pageCount; i += 1) {
    for (const annotation of pageAnnotations(doc, i)) {
      const action = annotation.get('A');
      if (action && !action.isNull() && String(action.get('S')) === '/JavaScript') {
        scripts.push({ location: `page ${i + 1} annotation`, source: scriptSource(action) });
      }
    }
  }

  return scripts;
}

export function countJavaScript(doc: mupdf.PDFDocument): number {
  let count = countNameTree(names(doc)?.get('JavaScript'));

  const openAction = root(doc)?.get('OpenAction');
  if (openAction && !openAction.isNull() && String(openAction.get('S')) === '/JavaScript') {
    count += 1;
  }

  const pageCount = doc.countPages();
  for (let i = 0; i < pageCount; i += 1) {
    for (const annotation of pageAnnotations(doc, i)) {
      if (actionType(annotation) === '/JavaScript') count += 1;
    }
  }
  return count;
}

export function countEmbeddedFiles(doc: mupdf.PDFDocument): number {
  let count = countNameTree(names(doc)?.get('EmbeddedFiles'));
  const pageCount = doc.countPages();
  for (let i = 0; i < pageCount; i += 1) {
    for (const annotation of pageAnnotations(doc, i)) {
      if (String(annotation.get('Subtype')) === '/FileAttachment') count += 1;
    }
  }
  return count;
}

/** Link annotations whose action leaves the document: URI, Launch, remote GoTo. */
export function countExternalLinks(doc: mupdf.PDFDocument): number {
  let count = 0;
  const pageCount = doc.countPages();
  for (let i = 0; i < pageCount; i += 1) {
    for (const annotation of pageAnnotations(doc, i)) {
      if (String(annotation.get('Subtype')) !== '/Link') continue;
      if (['/URI', '/Launch', '/GoToR'].includes(actionType(annotation))) count += 1;
    }
  }
  return count;
}

function filterAnnotations(
  doc: mupdf.PDFDocument,
  keep: (annotation: mupdf.PDFObject) => boolean,
): void {
  const pageCount = doc.countPages();
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageObj = doc.loadPage(pageIndex).getObject();
    const annots = pageObj.get('Annots');
    if (!annots || annots.isNull() || !annots.isArray()) continue;

    const kept = doc.newArray();
    for (let i = 0; i < annots.length; i += 1) {
      const annotation = annots.get(i);
      if (keep(annotation)) kept.push(annotation);
    }
    pageObj.put('Annots', kept);
  }
}

export const sanitizeTool: ToolDescriptor = {
  id: 'security.sanitize',
  category: 'security',
  name: { zh: '净化文档', en: 'Sanitise' },
  description: {
    zh: '移除 JavaScript、自动执行动作、内嵌文件和外部链接——处理来路不明的 PDF 前先过一遍。',
    en: 'Strip JavaScript, auto-run actions, embedded files and outbound links — run untrusted PDFs through this first.',
  },
  icon: 'ShieldCheck',
  keywords: ['sanitize', 'sanitise', 'javascript', 'malware', 'strip', 'clean', '净化', '脚本', '安全', '清理'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'strip',
      type: 'multiselect',
      label: { zh: '移除以下内容', en: 'Remove' },
      default: ['javascript', 'openActions', 'embeddedFiles', 'externalLinks'],
      minSelected: 1,
      options: [
        {
          value: 'javascript',
          label: { zh: 'JavaScript 脚本', en: 'JavaScript' },
          help: { zh: '文档级与批注上的全部脚本。', en: 'All document-level and annotation scripts.' },
        },
        {
          value: 'openActions',
          label: { zh: '打开时自动执行的动作', en: 'Auto-run open actions' },
        },
        {
          value: 'embeddedFiles',
          label: { zh: '内嵌文件与附件', en: 'Embedded files and attachments' },
        },
        {
          value: 'externalLinks',
          label: { zh: '外部链接（网址/启动程序）', en: 'External links (URLs / launch actions)' },
        },
      ],
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const strip = new Set(listParam(ctx, 'strip'));

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const removed = {
        javascript: strip.has('javascript') ? countJavaScript(doc) : 0,
        embeddedFiles: strip.has('embeddedFiles') ? countEmbeddedFiles(doc) : 0,
        externalLinks: strip.has('externalLinks') ? countExternalLinks(doc) : 0,
      };

      const rootObj = root(doc);
      const namesObj = names(doc);

      if (strip.has('javascript')) {
        namesObj?.delete('JavaScript');
        // Document-level additional-actions can hold scripts too.
        rootObj?.delete('AA');
        const openAction = rootObj?.get('OpenAction');
        if (openAction && !openAction.isNull() && String(openAction.get('S')) === '/JavaScript') {
          rootObj?.delete('OpenAction');
        }
        filterAnnotations(doc, (a) => actionType(a) !== '/JavaScript');
      }

      if (strip.has('openActions')) {
        rootObj?.delete('OpenAction');
        const pageCount = doc.countPages();
        for (let i = 0; i < pageCount; i += 1) {
          doc.loadPage(i).getObject().delete('AA');
        }
      }

      if (strip.has('embeddedFiles')) {
        namesObj?.delete('EmbeddedFiles');
        filterAnnotations(doc, (a) => String(a.get('Subtype')) !== '/FileAttachment');
      }

      if (strip.has('externalLinks')) {
        filterAnnotations(
          doc,
          (a) =>
            String(a.get('Subtype')) !== '/Link' ||
            !['/URI', '/Launch', '/GoToR'].includes(actionType(a)),
        );
      }

      // `sanitize` additionally makes MuPDF re-emit content streams, dropping
      // anything syntactically dubious that the object walk cannot see.
      const bytes = saveDocument(doc, { garbage: 'deduplicate', sanitize: true, clean: true });
      ctx.report(1);

      const total = removed.javascript + removed.embeddedFiles + removed.externalLinks;
      return {
        files: [pdfOutput(suffixedName(file.name, '_sanitized', '.pdf'), bytes)],
        summary: {
          zh:
            total > 0
              ? `已移除 ${removed.javascript} 处脚本、${removed.embeddedFiles} 个内嵌文件、${removed.externalLinks} 个外部链接`
              : '未发现活动内容，已重写为干净副本',
          en:
            total > 0
              ? `Removed ${removed.javascript} scripts, ${removed.embeddedFiles} embedded files, ${removed.externalLinks} external links`
              : 'No active content found — rewrote a clean copy',
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
