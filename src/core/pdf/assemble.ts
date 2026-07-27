import * as mupdf from 'mupdf';
import { ToolError } from '../errors.ts';
import { openDocument, saveDocument, type SaveOptions } from './document.ts';

/**
 * Page-level assembly, shared by every tool in the Organize category.
 *
 * MuPDF's `graftPage` is used rather than pdf-lib's `copyPages` because it
 * carries annotations and shared resources across documents properly, and
 * because it reads encrypted sources directly instead of needing a decrypt pass.
 */

export interface PageRef {
  doc: mupdf.PDFDocument;
  /** 0-based index into `doc`. */
  pageIndex: number;
}

/** Builds a new document from the given pages, in the order given. Caller destroys it. */
export function assemble(refs: readonly PageRef[]): mupdf.PDFDocument {
  if (refs.length === 0) {
    throw new ToolError('EMPTY_RESULT', 'Cannot assemble a document with zero pages', {
      zh: '这样操作后文档将不剩任何页面，请调整选择范围。',
      en: 'That would leave the document with no pages. Adjust your selection.',
    });
  }

  const out = new mupdf.PDFDocument();
  try {
    for (const ref of refs) {
      out.graftPage(-1, ref.doc, ref.pageIndex);
    }
  } catch (cause) {
    out.destroy();
    throw cause;
  }
  return out;
}

/**
 * Produces a new PDF containing the given 1-based pages of `bytes`, in order.
 * Duplicates are allowed — a page may be repeated.
 */
export function selectPages(
  bytes: Uint8Array,
  password: string,
  pages: readonly number[],
  saveOptions?: SaveOptions,
): Uint8Array {
  const source = openDocument(bytes, password);
  try {
    const pageCount = source.countPages();
    for (const page of pages) {
      if (page < 1 || page > pageCount) {
        throw new ToolError(
          'PAGE_OUT_OF_RANGE',
          `Page ${page} is outside the document (1-${pageCount})`,
          {
            zh: `第 ${page} 页超出文档范围（共 ${pageCount} 页）。`,
            en: `Page ${page} is outside this document, which has ${pageCount} pages.`,
          },
          { page, pageCount },
        );
      }
    }

    const out = assemble(pages.map((page) => ({ doc: source, pageIndex: page - 1 })));
    try {
      return saveDocument(out, saveOptions);
    } finally {
      out.destroy();
    }
  } finally {
    source.destroy();
  }
}

/** Rotation is stored as a multiple of 90 in [0, 360). */
export function normalizeRotation(degrees: number): number {
  return ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
}

/**
 * Applies a rotation to selected pages of an open document.
 * `mode` decides whether the angle replaces the page's existing rotation or adds to it.
 */
export function rotateDocumentPages(
  doc: mupdf.PDFDocument,
  pages: readonly number[],
  degrees: number,
  mode: 'add' | 'set',
): void {
  const delta = normalizeRotation(degrees);

  for (const page of pages) {
    const pageObject = doc.loadPage(page - 1).getObject();
    const current = mode === 'add' ? normalizeRotation(Number(pageObject.get('Rotate') ?? 0)) : 0;
    pageObject.put('Rotate', normalizeRotation(current + delta));
  }
}
