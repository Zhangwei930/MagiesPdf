import type { PdfDocumentHandle } from './renderer.ts';
import { rectFromDrag, toFractionRect, type Rect } from './geometry.ts';

export interface LinkBox {
  url?: string;
  dest?: string | unknown[];
  box: Rect;
}

export async function getLinkAnnotations(
  doc: PdfDocumentHandle,
  pageNumber: number,
): Promise<LinkBox[]> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const annotations = await page.getAnnotations();

  const links: LinkBox[] = [];
  for (const raw of annotations) {
    const annotation = raw as {
      subtype?: string;
      url?: string;
      dest?: string | unknown[];
      rect?: number[];
    };
    if (annotation.subtype !== 'Link') continue;

    const rect = annotation.rect;
    if (!Array.isArray(rect) || rect.length < 4) continue;

    const start = viewport.convertToViewportPoint(rect[0] ?? 0, rect[1] ?? 0);
    const end = viewport.convertToViewportPoint(rect[2] ?? 0, rect[3] ?? 0);

    links.push({
      url: annotation.url,
      dest: annotation.dest,
      box: toFractionRect(
        rectFromDrag({ x: start[0], y: start[1] }, { x: end[0], y: end[1] }),
        { width: viewport.width, height: viewport.height },
      ),
    });
  }
  return links;
}
