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

interface ObjectLocation {
  object: mupdf.PDFObject;
  parent: mupdf.PDFObject | null;
  key: number | string | null;
  path: string;
}

/**
 * Walk every object reachable from the catalogue once. PDF object graphs are
 * cyclic, so indirect object numbers are the identity boundary.
 */
function walkObjects(
  object: mupdf.PDFObject | null | undefined,
  visit: (location: ObjectLocation) => void,
  parent: mupdf.PDFObject | null = null,
  key: number | string | null = null,
  path = '$',
  seen = new Set<number>(),
): void {
  if (!object || object.isNull()) return;

  let current = object;
  if (current.isIndirect()) {
    const objectNumber = current.asIndirect();
    if (seen.has(objectNumber)) return;
    seen.add(objectNumber);
    current = current.resolve();
  }

  visit({ object: current, parent, key, path });
  if (!current.isArray() && !current.isDictionary() && !current.isStream()) return;

  const children: Array<{ value: mupdf.PDFObject; key: number | string }> = [];
  current.forEach((value, childKey) => children.push({ value, key: childKey }));
  for (const child of children) {
    walkObjects(
      child.value,
      visit,
      current,
      child.key,
      `${path}/${String(child.key)}`,
      seen,
    );
  }
}

function actionType(annotation: mupdf.PDFObject): string {
  const action = annotation.get('A');
  if (!action || action.isNull()) return '';
  return String(action.get('S'));
}

function isAction(object: mupdf.PDFObject, types: ReadonlySet<string>): boolean {
  return (
    (object.isDictionary() || object.isStream()) &&
    types.has(String(object.get('S')))
  );
}

function removeActions(doc: mupdf.PDFDocument, types: ReadonlySet<string>): void {
  const removals: Array<{ parent: mupdf.PDFObject; key: number | string }> = [];
  walkObjects(root(doc), ({ object, parent, key }) => {
    if (parent && key !== null && isAction(object, types)) {
      removals.push({ parent, key });
    }
  });
  for (const removal of removals) removal.parent.delete(removal.key);
}

function removeKeyEverywhere(doc: mupdf.PDFDocument, key: string): void {
  walkObjects(root(doc), ({ object }) => {
    if (!object.isDictionary() && !object.isStream()) return;
    const value = object.get(key);
    if (value && !value.isNull()) object.delete(key);
  });
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
  const javascript = new Set(['/JavaScript']);
  walkObjects(root(doc), ({ object, path }) => {
    if (isAction(object, javascript)) {
      const location =
        path === '$/OpenAction'
          ? 'open-action'
          : path.includes('/Names/JavaScript')
            ? 'named'
            : path.includes('/Annots')
              ? 'annotation'
              : path;
      scripts.push({ location, source: scriptSource(object) });
    }
  });

  return scripts;
}

export function countJavaScript(doc: mupdf.PDFDocument): number {
  return collectJavaScript(doc).length;
}

export function countEmbeddedFiles(doc: mupdf.PDFDocument): number {
  let count = 0;
  walkObjects(root(doc), ({ object }) => {
    if (
      (object.isDictionary() || object.isStream()) &&
      String(object.get('Type')) === '/Filespec' &&
      !object.get('EF').isNull()
    ) {
      count += 1;
    }
  });
  return count;
}

/** Every action that leaves the document: URI, Launch, or remote GoTo. */
export function countExternalLinks(doc: mupdf.PDFDocument): number {
  let count = 0;
  const external = new Set(['/URI', '/Launch', '/GoToR']);
  walkObjects(root(doc), ({ object }) => {
    if (isAction(object, external)) count += 1;
  });
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
        removeActions(doc, new Set(['/JavaScript']));
        // Additional-action dictionaries can live on the catalogue, pages,
        // annotations and AcroForm fields. Dropping the container is the only
        // reliable way to avoid a JavaScript action hidden behind an event key.
        removeKeyEverywhere(doc, 'AA');
        filterAnnotations(doc, (a) => actionType(a) !== '/JavaScript');
      }

      if (strip.has('openActions')) {
        rootObj?.delete('OpenAction');
        removeKeyEverywhere(doc, 'AA');
      }

      if (strip.has('embeddedFiles')) {
        namesObj?.delete('EmbeddedFiles');
        removeKeyEverywhere(doc, 'AF');
        removeKeyEverywhere(doc, 'EF');
        filterAnnotations(doc, (a) => String(a.get('Subtype')) !== '/FileAttachment');
      }

      if (strip.has('externalLinks')) {
        filterAnnotations(
          doc,
          (a) =>
            String(a.get('Subtype')) !== '/Link' ||
            !['/URI', '/Launch', '/GoToR'].includes(actionType(a)),
        );
        removeActions(doc, new Set(['/URI', '/Launch', '/GoToR']));
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
