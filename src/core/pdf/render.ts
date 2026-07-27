import * as mupdf from 'mupdf';

/** Rasterisation of PDF pages, shared by pdf-to-image and future previews. */

export interface RenderOptions {
  /** Dots per inch; PDF user space is 72/inch. */
  dpi: number;
  format: 'png' | 'jpeg';
  /** JPEG quality 1-100. Ignored for PNG. */
  quality?: number;
  /** Default `rgb`. `gray` is used by the grayscale tool. */
  colorspace?: 'rgb' | 'gray';
}

export interface RenderedPage {
  bytes: Uint8Array;
  width: number;
  height: number;
  mime: string;
  extension: string;
}

export interface PageInk {
  /** Fraction of rendered pixels that are not near-white, 0..1. */
  inkRatio: number;
  /** Bounding box of the inked area in PDF points (page coordinates), or null if blank. */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

/**
 * Renders a page at low resolution and measures where its visible content is.
 * Drives blank-page detection and auto-cropping; 36 dpi keeps it cheap while
 * still resolving anything a human would call content.
 */
export function analyzePageInk(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  options: { dpi?: number; whiteThreshold?: number } = {},
): PageInk {
  const dpi = options.dpi ?? 36;
  const whiteThreshold = options.whiteThreshold ?? 245;
  const scale = dpi / 72;

  const page = doc.loadPage(pageIndex);
  const [pageX0, , , pageY1] = page.getBounds();
  const pixmap = page.toPixmap(
    mupdf.Matrix.scale(scale, scale),
    mupdf.ColorSpace.DeviceRGB,
    false,
    true,
  );

  try {
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const stride = pixmap.getStride();
    const components = pixmap.getNumberOfComponents();
    // A live view into the WASM heap — read it fully here, never hold onto it.
    const pixels = pixmap.getPixels();

    let inked = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      const row = y * stride;
      for (let x = 0; x < width; x += 1) {
        const offset = row + x * components;
        // "Ink" is any pixel darker than near-white in any channel.
        if (
          (pixels[offset] as number) < whiteThreshold ||
          (pixels[offset + 1] as number) < whiteThreshold ||
          (pixels[offset + 2] as number) < whiteThreshold
        ) {
          inked += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX === -1) return { inkRatio: 0, bbox: null };

    const toPt = 72 / dpi;
    return {
      inkRatio: inked / (width * height),
      bbox: {
        x0: pageX0 + minX * toPt,
        // Pixel rows count from the top; PDF y counts from the bottom.
        y0: pageY1 - (maxY + 1) * toPt,
        x1: pageX0 + (maxX + 1) * toPt,
        y1: pageY1 - minY * toPt,
      },
    };
  } finally {
    pixmap.destroy();
  }
}

export function renderPage(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  options: RenderOptions,
): RenderedPage {
  const scale = options.dpi / 72;
  const page = doc.loadPage(pageIndex);

  // No alpha: JPEG cannot carry it, and PNG pages want a white ground anyway.
  const space =
    options.colorspace === 'gray' ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
  const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), space, false, true);

  try {
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();

    if (options.format === 'jpeg') {
      return {
        bytes: pixmap.asJPEG(options.quality ?? 85, false),
        width,
        height,
        mime: 'image/jpeg',
        extension: '.jpg',
      };
    }
    return { bytes: pixmap.asPNG(), width, height, mime: 'image/png', extension: '.png' };
  } finally {
    pixmap.destroy();
  }
}
