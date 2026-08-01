import * as mupdf from 'mupdf';

/**
 * Text overlays drawn directly into page content streams — the machinery behind
 * watermarks and page numbers.
 *
 * The overlay text is written with MuPDF's built-in CJK fallback font through
 * `addCJKFont`, so Chinese (and Latin, which the same font covers) works without
 * shipping a font file. Text is encoded as UTF-16BE hex against Identity-H.
 */

/** Overlay resources already added to a document, so N pages share one font. */
const FONT_CACHE = new WeakMap<mupdf.PDFDocument, mupdf.PDFObject>();

const OVERLAY_FONT_KEY = 'MgOvF';

export function ensureOverlayFont(doc: mupdf.PDFDocument): mupdf.PDFObject {
  let ref = FONT_CACHE.get(doc);
  if (!ref) {
    // "zh-Hans" resolves to the bundled Droid Sans Fallback, which covers CJK
    // plus Latin — one font for every overlay string we support.
    ref = doc.addCJKFont(new mupdf.Font('zh-Hans'), 'zh-Hans', 0, false);
    FONT_CACHE.set(doc, ref);
  }
  return ref;
}

/** UTF-16BE hex string for an Identity-H `Tj`, surrogate pairs included. */
export function hexUtf16(text: string): string {
  let hex = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint > 0xffff) {
      const high = 0xd800 + ((codePoint - 0x10000) >> 10);
      const low = 0xdc00 + ((codePoint - 0x10000) & 0x3ff);
      hex += high.toString(16).padStart(4, '0') + low.toString(16).padStart(4, '0');
    } else {
      hex += codePoint.toString(16).padStart(4, '0');
    }
  }
  return hex;
}

/** Width of `text` at `size` points, from the overlay font's glyph advances. */
export function measureText(text: string, size: number): number {
  const font = new mupdf.Font('zh-Hans');
  let width = 0;
  for (const character of text) {
    const glyph = font.encodeCharacter(character.codePointAt(0) as number);
    width += font.advanceGlyph(glyph, 0);
  }
  return width * size;
}

/** `#rrggbb` → `r g b rg` operands in 0..1. */
export function colorOperands(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`;
}

function ensureDictionary(
  doc: mupdf.PDFDocument,
  parent: mupdf.PDFObject,
  key: string,
): mupdf.PDFObject {
  let child = parent.get(key);
  if (!child || child.isNull()) {
    child = doc.newDictionary();
    parent.put(key, child);
  }
  return child;
}

function pageResources(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject): mupdf.PDFObject {
  let resources = pageObj.get('Resources');
  if (!resources || resources.isNull()) {
    // Resources may be inherited from the page tree; materialise them onto the
    // page so our additions cannot leak into unrelated pages via a shared node.
    const inherited = pageObj.getInheritable?.('Resources');
    resources = inherited && !inherited.isNull() ? inherited : doc.newDictionary();
    pageObj.put('Resources', resources);
  }
  return resources;
}

/**
 * Appends a content stream to a page, preserving whatever is already there.
 *
 * The original streams are bracketed by `q`/`Q` streams first, so a body that
 * leaves the graphics state unbalanced cannot skew the overlay. `Contents` may
 * be a single stream, an array, or absent — all three occur in the wild, and
 * naively wrapping the existing array in another array corrupts the page.
 */
export function appendContentStream(
  doc: mupdf.PDFDocument,
  pageObj: mupdf.PDFObject,
  content: string,
): void {
  const pushRef = doc.addStream('q\n', {});
  const popAndDraw = doc.addStream(`Q\n${content}\n`, {});

  const existing = pageObj.get('Contents');
  const list = doc.newArray();
  list.push(pushRef);

  if (existing && !existing.isNull()) {
    if (existing.isArray()) {
      for (let i = 0; i < existing.length; i += 1) list.push(existing.get(i));
    } else {
      list.push(existing);
    }
  }

  list.push(popAndDraw);
  pageObj.put('Contents', list);
}

export interface TextStampSpec {
  text: string;
  size: number;
  /** `#rrggbb`. */
  color: string;
  /** 0..1 fill opacity. */
  opacity: number;
  /** Counter-clockwise degrees. */
  rotateDegrees: number;
  /** Repeat the text in a grid covering the page instead of stamping once. */
  tile: boolean;
  /** Extra spacing between tiles, in multiples of the text width. */
  tileGap?: number;
}

let gsCounter = 0;

/**
 * Stamps text onto one page of an open document. The caller saves the document
 * once after stamping however many pages it wants.
 */
export function stampTextOnPage(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  spec: TextStampSpec,
): void {
  const page = doc.loadPage(pageIndex);
  const pageObj = page.getObject();
  const [x0, y0, x1, y1] = page.getBounds();
  const pageWidth = x1 - x0;
  const pageHeight = y1 - y0;

  const resources = pageResources(doc, pageObj);
  ensureDictionary(doc, resources, 'Font').put(OVERLAY_FONT_KEY, ensureOverlayFont(doc));

  // A fresh ExtGState key per stamp, so two stamps with different opacity on
  // the same page cannot fight over one entry.
  const gsKey = `MgOvGs${(gsCounter += 1)}`;
  const gs = doc.newDictionary();
  gs.put('ca', spec.opacity);
  gs.put('CA', spec.opacity);
  ensureDictionary(doc, resources, 'ExtGState').put(gsKey, doc.addObject(gs));

  const radians = (spec.rotateDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const textWidth = measureText(spec.text, spec.size);
  const hex = hexUtf16(spec.text);

  const centerX = x0 + pageWidth / 2;
  const centerY = y0 + pageHeight / 2;

  /** One `Tm … Tj` at a rotated position offset (dx, dy) from the page centre. */
  const stampAt = (dx: number, dy: number): string => {
    const originX = centerX + dx * cos - dy * sin - (textWidth / 2) * cos;
    const originY = centerY + dx * sin + dy * cos - (textWidth / 2) * sin;
    const tm = `${cos.toFixed(5)} ${sin.toFixed(5)} ${(-sin).toFixed(5)} ${cos.toFixed(5)} ${originX.toFixed(2)} ${originY.toFixed(2)} Tm`;
    return `${tm} <${hex}> Tj`;
  };

  const stamps: string[] = [];
  if (spec.tile) {
    // Cover the page's diagonal so rotation leaves no bare corners.
    const reach = Math.hypot(pageWidth, pageHeight) / 2;
    const stepX = textWidth * (1 + (spec.tileGap ?? 1));
    const stepY = spec.size * 6;
    for (let dy = -reach; dy <= reach; dy += stepY) {
      // Stagger alternate rows for a plate-proof pattern.
      const offset = Math.round(dy / stepY) % 2 === 0 ? 0 : stepX / 2;
      for (let dx = -reach - offset; dx <= reach; dx += stepX) {
        stamps.push(stampAt(dx + offset, dy));
      }
    }
  } else {
    stamps.push(stampAt(0, 0));
  }

  const content = [
    `q /${gsKey} gs`,
    'BT',
    `/${OVERLAY_FONT_KEY} ${spec.size} Tf`,
    colorOperands(spec.color),
    ...stamps,
    'ET Q',
  ].join('\n');

  appendContentStream(doc, pageObj, content);
}

export interface InvisibleWord {
  text: string;
  /** Baseline origin in PDF points (bottom-left coordinate system). */
  x: number;
  y: number;
  /** Font size in points, normally the recognised line height. */
  size: number;
  /** Width the word must occupy, so selection rectangles match the scan. */
  targetWidth: number;
}

/**
 * Lays an invisible text layer over a page — the searchable-PDF half of OCR.
 *
 * Text render mode 3 draws nothing but still participates in selection, search
 * and copy. Each word is horizontally scaled (`Tz`) so its selectable box lines
 * up with the printed word in the scan underneath.
 */
export function stampInvisibleWords(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  words: readonly InvisibleWord[],
): void {
  if (words.length === 0) return;

  const page = doc.loadPage(pageIndex);
  const pageObj = page.getObject();

  const resources = pageResources(doc, pageObj);
  ensureDictionary(doc, resources, 'Font').put(OVERLAY_FONT_KEY, ensureOverlayFont(doc));

  const parts: string[] = ['q BT', '3 Tr'];
  for (const word of words) {
    if (word.text.trim() === '' || word.size <= 0) continue;
    const natural = measureText(word.text, word.size);
    const scale = natural > 0 ? (word.targetWidth / natural) * 100 : 100;
    parts.push(
      `/${OVERLAY_FONT_KEY} ${word.size.toFixed(2)} Tf`,
      `${Math.max(1, Math.min(scale, 1000)).toFixed(1)} Tz`,
      `1 0 0 1 ${word.x.toFixed(2)} ${word.y.toFixed(2)} Tm`,
      `<${hexUtf16(word.text)}> Tj`,
    );
  }
  parts.push('ET Q');

  appendContentStream(doc, pageObj, parts.join('\n'));
}

export type Anchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface AnchoredTextSpec {
  text: string;
  size: number;
  color: string;
  anchor: Anchor;
  /** Distance from the page edges, in points. */
  margin: number;
}

export interface PointTextSpec {
  text: string;
  /** PDF text matrix, including the baseline origin and page rotation. */
  matrix: mupdf.Matrix;
  size: number;
  color: string;
}

/** Places one line of directly entered text at an exact point on the page. */
export function placeTextAtPoint(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  spec: PointTextSpec,
): void {
  const pageObj = doc.loadPage(pageIndex).getObject();
  const resources = pageResources(doc, pageObj);
  ensureDictionary(doc, resources, 'Font').put(OVERLAY_FONT_KEY, ensureOverlayFont(doc));
  const matrix = spec.matrix.map((value) => value.toFixed(4)).join(' ');

  const content = [
    'q BT',
    `/${OVERLAY_FONT_KEY} ${spec.size} Tf`,
    colorOperands(spec.color),
    `${matrix} Tm`,
    `<${hexUtf16(spec.text)}> Tj`,
    'ET Q',
  ].join('\n');

  appendContentStream(doc, pageObj, content);
}

/** Places a line of text at a page-edge anchor — the page-number primitive. */
export function placeTextOnPage(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  spec: AnchoredTextSpec,
): void {
  const page = doc.loadPage(pageIndex);
  const pageObj = page.getObject();
  const [x0, y0, x1, y1] = page.getBounds();

  const textWidth = measureText(spec.text, spec.size);

  let x: number;
  if (spec.anchor.endsWith('left')) x = x0 + spec.margin;
  else if (spec.anchor.endsWith('right')) x = x1 - spec.margin - textWidth;
  else x = x0 + (x1 - x0 - textWidth) / 2;

  // `y` is the text baseline; nudge by ~20% of the size so descenders clear the edge.
  const y = spec.anchor.startsWith('top')
    ? y1 - spec.margin - spec.size * 0.8
    : y0 + spec.margin + spec.size * 0.2;

  const resources = pageResources(doc, pageObj);
  ensureDictionary(doc, resources, 'Font').put(OVERLAY_FONT_KEY, ensureOverlayFont(doc));

  const content = [
    'q BT',
    `/${OVERLAY_FONT_KEY} ${spec.size} Tf`,
    colorOperands(spec.color),
    `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
    `<${hexUtf16(spec.text)}> Tj`,
    'ET Q',
  ].join('\n');

  appendContentStream(doc, pageObj, content);
}
