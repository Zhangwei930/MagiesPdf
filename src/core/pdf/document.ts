import * as mupdf from 'mupdf';
import { PDFDocument as PdfLibDocument } from 'pdf-lib';
import { ToolError } from '../errors.ts';

/**
 * Bridge between the two PDF engines MagiesPdf uses.
 *
 * MuPDF owns document-level concerns — decryption, encryption, compression,
 * rendering, text extraction — because it is the only one of the two that can
 * read an encrypted file at all. pdf-lib owns page composition and drawing,
 * where its API is far more ergonomic.
 *
 * Anything that hands bytes to pdf-lib must therefore go through
 * {@link decryptToBytes} first, so tools never have to think about encryption.
 */

export const PDF_MIME = 'application/pdf';

/** MuPDF returns 0 for "wrong password", 1/2 for user, 4/6 for owner. */
const AUTH_FAILED = 0;

function corrupt(cause: unknown): ToolError {
  return new ToolError(
    'CORRUPT_DOCUMENT',
    `Failed to open PDF: ${cause instanceof Error ? cause.message : String(cause)}`,
    {
      zh: '无法打开这个 PDF，文件可能已损坏。可以先用「修复 PDF」试试。',
      en: 'This PDF could not be opened — the file may be damaged. Try the Repair PDF tool first.',
    },
  );
}

/**
 * Opens a document with MuPDF, authenticating if it is encrypted.
 * The caller owns the returned document and must call `.destroy()` on it —
 * prefer {@link withDocument}, which does that automatically.
 */
export function openDocument(bytes: Uint8Array, password = ''): mupdf.PDFDocument {
  let doc: mupdf.PDFDocument;
  try {
    doc = mupdf.PDFDocument.openDocument(bytes, PDF_MIME) as mupdf.PDFDocument;
  } catch (cause) {
    throw corrupt(cause);
  }

  if (!doc.needsPassword()) return doc;

  if (password === '') {
    doc.destroy();
    throw new ToolError('PASSWORD_REQUIRED', 'Document is encrypted and no password was supplied', {
      zh: '这个 PDF 已加密，请先填写打开密码。',
      en: 'This PDF is encrypted. Enter its password to continue.',
    });
  }

  if (doc.authenticatePassword(password) === AUTH_FAILED) {
    doc.destroy();
    throw new ToolError('WRONG_PASSWORD', 'Supplied password was rejected by the document', {
      zh: '密码不正确，请重新输入。',
      en: 'That password was not accepted. Please try again.',
    });
  }

  return doc;
}

/** Runs `fn` against an opened document and always releases the WASM handle after. */
export async function withDocument<T>(
  bytes: Uint8Array,
  password: string,
  fn: (doc: mupdf.PDFDocument) => T | Promise<T>,
): Promise<T> {
  const doc = openDocument(bytes, password);
  try {
    return await fn(doc);
  } finally {
    doc.destroy();
  }
}

export interface SaveOptions {
  /**
   * Re-encode streams with Flate. Note MuPDF already compresses streams on a
   * default save, so this only matters alongside `compressImages`/`compressFonts`
   * or after a `decompress` round-trip.
   */
  compress?: boolean;
  compressImages?: boolean;
  compressFonts?: boolean;
  /** Pack objects into compressed object streams (often another ~10–25%). */
  objstms?: boolean;
  /** Write every stream uncompressed, for inspecting or repairing raw structure. */
  decompress?: boolean;
  /** `compact` merges duplicate objects; `deduplicate`/`compact` are MuPDF's garbage levels. */
  garbage?: 'none' | 'compact' | 'deduplicate';
  /** Drop broken/unreferenced structures instead of preserving them verbatim. */
  clean?: boolean;
  sanitize?: boolean;
  encryption?: {
    method: 'rc4-128' | 'aes-128' | 'aes-256';
    userPassword: string;
    ownerPassword: string;
    /** Encryption permission bitfield — see `permissions.ts`. */
    permissions: number;
  };
}

/**
 * Serialises a MuPDF document.
 *
 * MuPDF defaults to `encrypt=keep`, which silently carries the source file's
 * encryption into the output. Every save therefore states its intent explicitly:
 * `encrypt=none` unless an encryption block was requested.
 */
export function saveDocument(doc: mupdf.PDFDocument, options: SaveOptions = {}): Uint8Array {
  const flags: string[] = [];

  if (options.decompress && options.compress) {
    throw new ToolError('INVALID_PARAM', 'saveDocument: compress and decompress are mutually exclusive', {
      zh: '压缩和解压缩不能同时启用。',
      en: 'Compression and decompression cannot both be enabled.',
    });
  }

  if (options.decompress) flags.push('decompress');
  if (options.compress) flags.push('compress');
  if (options.compressImages) flags.push('compress-images');
  if (options.compressFonts) flags.push('compress-fonts');
  if (options.objstms) flags.push('objstms');
  if (options.clean) flags.push('clean');
  if (options.sanitize) flags.push('sanitize');
  if (options.garbage && options.garbage !== 'none') flags.push(`garbage=${options.garbage}`);

  if (options.encryption) {
    const { method, userPassword, ownerPassword, permissions } = options.encryption;
    flags.push(
      `encrypt=${method}`,
      `user-password=${userPassword}`,
      `owner-password=${ownerPassword}`,
      `permissions=${permissions}`,
    );
  } else {
    flags.push('encrypt=none');
  }

  try {
    const buffer = doc.saveToBuffer(flags.join(','));
    try {
      // `asUint8Array()` hands back a *view* into the WASM heap, not a copy. That
      // view dangles as soon as the buffer is freed or the heap is reallocated,
      // and it cannot be transferred across a worker boundary. Copy it out here,
      // once, so every caller gets bytes it actually owns.
      return new Uint8Array(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  } catch (cause) {
    throw new ToolError(
      'INTERNAL',
      `Failed to save PDF (${flags.join(',')}): ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        zh: '保存 PDF 时出错，请重试或改用其他选项。',
        en: 'Saving the PDF failed. Try again, or change the options.',
      },
    );
  }
}

/**
 * Returns bytes pdf-lib can load: decrypted when the source was encrypted,
 * and the untouched original otherwise so nothing is re-encoded needlessly.
 */
export function decryptToBytes(bytes: Uint8Array, password = ''): Uint8Array {
  const doc = mupdf.PDFDocument.openDocument(bytes, PDF_MIME) as mupdf.PDFDocument;
  try {
    if (!doc.needsPassword()) return bytes;
  } catch (cause) {
    doc.destroy();
    throw corrupt(cause);
  }
  doc.destroy();

  return withDocumentSync(bytes, password, (opened) => saveDocument(opened));
}

/** Synchronous sibling of {@link withDocument}, used where no await is needed. */
export function withDocumentSync<T>(
  bytes: Uint8Array,
  password: string,
  fn: (doc: mupdf.PDFDocument) => T,
): T {
  const doc = openDocument(bytes, password);
  try {
    return fn(doc);
  } finally {
    doc.destroy();
  }
}

/** Loads a document into pdf-lib, transparently decrypting first when required. */
export async function loadForEditing(
  bytes: Uint8Array,
  password = '',
): Promise<PdfLibDocument> {
  const plain = decryptToBytes(bytes, password);
  try {
    return await PdfLibDocument.load(plain, { updateMetadata: false });
  } catch (cause) {
    throw corrupt(cause);
  }
}

/** Counts pages without fully materialising the document in pdf-lib. */
export function countPages(bytes: Uint8Array, password = ''): number {
  return withDocumentSync(bytes, password, (doc) => doc.countPages());
}

export async function saveEdited(doc: PdfLibDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}
