import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openDocument, saveDocument } from '../pdf/document.ts';
import type { ToolInputFile } from '../types.ts';

/**
 * PDF builders for tests. Only ever imported from `*.test.ts`, so it never
 * reaches the worker bundle or the renderer.
 */

export interface SamplePdfOptions {
  pages?: number;
  /** Page size in points. Defaults to A4 portrait. */
  size?: [number, number];
  /** Text stamped on page N, defaulting to `Page N`. */
  label?: (pageNumber: number) => string;
  /**
   * Extra filler lines per page. A default fixture's content streams are only a
   * few dozen bytes, where Flate framing costs more than it saves — tests about
   * compression need real, repetitive body text to measure against.
   */
  bodyLines?: number;
}

const FILLER = 'The quick brown fox jumps over the lazy dog. ';

/** A minimal, valid PDF with one large label per page — enough to assert page identity. */
export async function samplePdf(options: SamplePdfOptions = {}): Promise<Uint8Array> {
  const {
    pages = 3,
    size = [595, 842] as [number, number],
    label = (n: number) => `Page ${n}`,
    bodyLines = 0,
  } = options;

  const doc = await PDFDocument.create();
  doc.setTitle('MagiesPdf fixture');
  doc.setProducer('MagiesPdf tests');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage(size);
    // An empty label yields a genuinely blank page, for blank-detection tests.
    const text = label(i);
    if (text !== '') {
      page.drawText(text, { x: 48, y: size[1] - 120, size: 36, font, color: rgb(0, 0, 0) });
    }
    for (let line = 0; line < bodyLines; line += 1) {
      page.drawText(FILLER.repeat(2), {
        x: 48,
        y: size[1] - 180 - line * 14,
        size: 9,
        font,
        color: rgb(0.2, 0.2, 0.2),
      });
    }
  }

  return doc.save({ useObjectStreams: false });
}

/** Wraps raw bytes as a tool input file. */
export function asInput(bytes: Uint8Array, name = 'sample.pdf', mime = 'application/pdf'): ToolInputFile {
  return { name, bytes, mime };
}

export interface EncryptOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: number;
  method?: 'rc4-128' | 'aes-128' | 'aes-256';
}

/** Encrypts an existing PDF so tests can exercise the password paths. */
export function encryptPdf(bytes: Uint8Array, options: EncryptOptions = {}): Uint8Array {
  const {
    userPassword = 'user-pw',
    ownerPassword = 'owner-pw',
    permissions = -1,
    method = 'aes-256',
  } = options;

  const doc = openDocument(bytes);
  try {
    return saveDocument(doc, {
      encryption: { method, userPassword, ownerPassword, permissions },
    });
  } finally {
    doc.destroy();
  }
}

/** Extracts the visible text of one page, used to assert which page ended up where. */
export function pageText(bytes: Uint8Array, pageIndex: number, password = ''): string {
  const doc = openDocument(bytes, password);
  try {
    return doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asText().trim();
  } finally {
    doc.destroy();
  }
}

/** All page labels in order — the workhorse assertion for reordering tools. */
export function allPageText(bytes: Uint8Array, password = ''): string[] {
  const doc = openDocument(bytes, password);
  try {
    return Array.from({ length: doc.countPages() }, (_, i) =>
      doc.loadPage(i).toStructuredText('preserve-whitespace').asText().trim(),
    );
  } finally {
    doc.destroy();
  }
}
