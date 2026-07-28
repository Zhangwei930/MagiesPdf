import { ToolError } from '../errors.ts';

/**
 * Placing something at a point the user clicked on a *rendered* page.
 *
 * Renderers (pdfjs, MuPDF) present a page with its `/Rotate` already applied,
 * origin top-left, y downward. pdf-lib draws in the raw media box instead:
 * unrotated, origin bottom-left. Everything that takes a clicked coordinate
 * has to cross that gap, so the conversion lives here with its own tests.
 */

export type PageRotation = 0 | 90 | 180 | 270;

export interface PointPt {
  x: number;
  y: number;
}

export interface SizePt {
  width: number;
  height: number;
}

export function asRotation(angle: number): PageRotation {
  const normalized = ((angle % 360) + 360) % 360;
  if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  throw new ToolError('INVALID_INPUT', `Unsupported page rotation ${angle}`, {
    zh: `页面旋转角度 ${angle}° 不受支持。`,
    en: `A page rotation of ${angle}° is not supported.`,
  });
}

/** The size a viewer shows for a page — the media box, swapped on a quarter turn. */
export function displayedSize(media: SizePt, rotation: PageRotation): SizePt {
  return rotation === 90 || rotation === 270
    ? { width: media.height, height: media.width }
    : { width: media.width, height: media.height };
}

/**
 * Converts a point on the displayed page (top-left origin, y down) into the
 * coordinates pdf-lib draws in (unrotated media box, bottom-left origin).
 */
export function displayPointToMedia(
  point: PointPt,
  media: SizePt,
  rotation: PageRotation,
): PointPt {
  const { width: w, height: h } = media;

  // Top-left-origin position within the unrotated page.
  let ux: number;
  let uy: number;
  switch (rotation) {
    case 0:
      ux = point.x;
      uy = point.y;
      break;
    case 90:
      ux = point.y;
      uy = h - point.x;
      break;
    case 180:
      ux = w - point.x;
      uy = h - point.y;
      break;
    case 270:
      ux = w - point.y;
      uy = point.x;
      break;
  }

  // pdf-lib measures y up from the bottom.
  return { x: ux, y: h - uy };
}
