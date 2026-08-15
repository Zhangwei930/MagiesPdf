#!/usr/bin/env node
/**
 * Regenerates the brand assets from `build/logo-source.png`.
 *
 * Kept as a script rather than done by hand so the icons can be rebuilt when
 * the artwork changes, and so what was done to the source is written down.
 *
 * The source artwork draws its own rounded tile on an opaque background. Left
 * that way a macOS icon is a white square — the Dock does not mask icons, it
 * shows what it is given — so the area outside the tile is made transparent
 * here. Everything else is a straight resize.
 *
 * Usage: node scripts/brand-assets.mjs [--source=<png>]
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// ---- a very small PNG reader/writer ---------------------------------------
// Only what this script meets: 8-bit RGB or RGBA, no interlacing.

function readChunks(buffer) {
  const chunks = [];
  let at = 8;
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    chunks.push({ type, data: buffer.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes to a flat RGBA byte array. */
function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const header = chunks.find((chunk) => chunk.type === 'IHDR').data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const colorType = header[9];
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG: depth ${depth}, colour type ${colorType}`);
  }
  if (header[12] !== 0) throw new Error('Interlaced PNG is not supported');

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4, 255);
  const line = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let at = 0; at < stride; at += 1) {
      const left = at >= channels ? line[at - channels] : 0;
      const up = previous[at];
      const upLeft = at >= channels ? previous[at - channels] : 0;
      if (filter === 1) line[at] = (line[at] + left) & 255;
      else if (filter === 2) line[at] = (line[at] + up) & 255;
      else if (filter === 3) line[at] = (line[at] + ((left + up) >> 1)) & 255;
      else if (filter === 4) line[at] = (line[at] + paeth(left, up, upLeft)) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4;
      const from = x * channels;
      out[to] = line[from];
      out[to + 1] = line[from + 1];
      out[to + 2] = line[from + 2];
      out[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    line.copy(previous);
  }
  return { width, height, pixels: out };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- the one transform this artwork needs ---------------------------------

/**
 * Clears everything outside the artwork's own rounded tile.
 *
 * The tile is found rather than assumed: the outer background is a flat colour,
 * so the first row/column that differs from the corner pixel bounds it. That
 * survives the artwork being re-exported at a different size or padding.
 */
function cutOutRoundedTile(image) {
  const { width, height, pixels } = image;
  const at = (x, y) => (y * width + x) * 4;
  const background = [pixels[0], pixels[1], pixels[2]];
  const differs = (x, y) => {
    const i = at(x, y);
    return (
      Math.abs(pixels[i] - background[0]) > 6 ||
      Math.abs(pixels[i + 1] - background[1]) > 6 ||
      Math.abs(pixels[i + 2] - background[2]) > 6
    );
  };

  const middle = Math.floor(height / 2);
  let left = 0;
  while (left < width && !differs(left, middle)) left += 1;
  let right = width - 1;
  while (right > left && !differs(right, middle)) right -= 1;
  const centre = Math.floor(width / 2);
  let top = 0;
  while (top < height && !differs(centre, top)) top += 1;
  let bottom = height - 1;
  while (bottom > top && !differs(centre, bottom)) bottom -= 1;

  // Apple's squircle is close enough to a 22% corner radius at icon sizes.
  const boxWidth = right - left + 1;
  const boxHeight = bottom - top + 1;
  const radius = Math.round(Math.min(boxWidth, boxHeight) * 0.22);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let inside = x >= left && x <= right && y >= top && y <= bottom;
      if (inside) {
        // Only the four corner squares need the rounded test.
        const dx = x < left + radius ? left + radius - x : x > right - radius ? x - (right - radius) : 0;
        const dy = y < top + radius ? top + radius - y : y > bottom - radius ? y - (bottom - radius) : 0;
        if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > radius) inside = false;
      }
      if (!inside) pixels[at(x, y) + 3] = 0;
    }
  }
  return { image, box: { left, top, width: boxWidth, height: boxHeight } };
}

/**
 * Builds the app-icon variant: the mark alone, without the wordmark.
 *
 * At 32px (Finder lists) and 16px (menus) the "MagiesOffice" lettering is a
 * smudge, so the icon carries only the M and the full lockup stays for places
 * with room for it. The wordmark is *found* rather than assumed: inside the
 * tile the artwork is bands of ink separated by clear rows, and the last band
 * is the lettering. That keeps working if the artwork is redrawn.
 */
function markOnly(image, box) {
  const { width, pixels } = image;
  const at = (x, y) => (y * width + x) * 4;
  // Sampled inside the tile — though barely distinguishable from the page: this
  // artwork's tile is 253,253,253 against a 255,255,254 background, which is
  // why the icon is composed below rather than cropped to a tile edge that
  // cannot reliably be found.
  const inset = Math.round(box.width * 0.5);
  const paper = [
    pixels[at(box.left + inset, box.top + 4)],
    pixels[at(box.left + inset, box.top + 4) + 1],
    pixels[at(box.left + inset, box.top + 4) + 2],
  ];
  const isInk = (x, y) => {
    const i = at(x, y);
    if (pixels[i + 3] === 0) return false;
    return (
      Math.abs(pixels[i] - paper[0]) > 24 ||
      Math.abs(pixels[i + 1] - paper[1]) > 24 ||
      Math.abs(pixels[i + 2] - paper[2]) > 24
    );
  };

  const rowInk = [];
  for (let y = box.top; y <= box.top + box.height - 1; y += 1) {
    let count = 0;
    for (let x = box.left; x <= box.left + box.width - 1; x += 4) if (isInk(x, y)) count += 1;
    rowInk.push(count);
  }
  const peak = Math.max(...rowInk);
  const rowHasInk = rowInk.map((count) => count > 2);

  const found = [];
  let start = -1;
  rowHasInk.forEach((inked, index) => {
    if (inked && start < 0) start = index;
    if (!inked && start >= 0) {
      found.push([start, index - 1]);
      start = -1;
    }
  });
  if (start >= 0) found.push([start, rowHasInk.length - 1]);

  // The tile's drop shadow smears a faint band below the artwork that is tall
  // enough to look like content but far too thin in ink. Judge a band by how
  // dark it gets at its darkest, not by how many rows it spans.
  const minimumBand = Math.round(box.height * 0.03);
  const bands = found.filter(([from, to]) => {
    if (to - from + 1 < minimumBand) return false;
    return Math.max(...rowInk.slice(from, to + 1)) >= peak * 0.1;
  });
  if (bands.length < 2) {
    console.log('[brand] no separate wordmark band found — icon keeps the whole tile');
    return image;
  }

  const markTop = box.top + bands[0][0];
  const markBottom = box.top + bands[0][1];
  const wordmark = bands[1];
  console.log(
    `[brand] mark rows ${markTop}–${markBottom}; ` +
    `wordmark rows ${box.top + wordmark[0]}–${box.top + wordmark[1]} dropped from the icon`,
  );

  // The mark's own width, so it can be centred rather than assumed centred.
  let markLeft = box.left + box.width;
  let markRight = box.left;
  for (let y = markTop; y <= markBottom; y += 1) {
    for (let x = box.left; x < box.left + box.width; x += 1) {
      if (!isInk(x, y)) continue;
      if (x < markLeft) markLeft = x;
      if (x > markRight) markRight = x;
    }
  }

  // Compose a fresh tile instead of cropping to one. A macOS icon grid gives
  // the glyph roughly 62% of the canvas; matching that is what makes the icon
  // sit correctly next to other apps in the Dock.
  const markWidth = markRight - markLeft + 1;
  const markHeight = markBottom - markTop + 1;
  const side = Math.round(Math.max(markWidth, markHeight) / 0.62);
  const out = Buffer.alloc(side * side * 4);
  const to = (x, y) => (y * side + x) * 4;
  for (let i = 0; i < out.length; i += 4) {
    out[i] = paper[0];
    out[i + 1] = paper[1];
    out[i + 2] = paper[2];
    out[i + 3] = 255;
  }
  const offsetX = Math.round((side - markWidth) / 2);
  const offsetY = Math.round((side - markHeight) / 2);
  for (let y = 0; y < markHeight; y += 1) {
    for (let x = 0; x < markWidth; x += 1) {
      const from = at(markLeft + x, markTop + y);
      if (pixels[from + 3] === 0) continue;
      const target = to(offsetX + x, offsetY + y);
      out[target] = pixels[from];
      out[target + 1] = pixels[from + 1];
      out[target + 2] = pixels[from + 2];
      out[target + 3] = 255;
    }
  }

  // Round the corners of the tile just composed — its edges are exact, so the
  // radius is applied directly rather than searched for.
  const radius = Math.round(side * 0.22);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const dx = x < radius ? radius - x : x > side - 1 - radius ? x - (side - 1 - radius) : 0;
      const dy = y < radius ? radius - y : y > side - 1 - radius ? y - (side - 1 - radius) : 0;
      if (dx > 0 && dy > 0 && Math.hypot(dx, dy) > radius) out[to(x, y) + 3] = 0;
    }
  }
  return { width: side, height: side, pixels: out };
}

function addTransparentMargin(image, scale) {
  const side = Math.ceil(Math.max(image.width, image.height) / scale);
  const pixels = Buffer.alloc(side * side * 4);
  const offsetX = Math.floor((side - image.width) / 2);
  const offsetY = Math.floor((side - image.height) / 2);

  for (let y = 0; y < image.height; y += 1) {
    const from = y * image.width * 4;
    const to = ((y + offsetY) * side + offsetX) * 4;
    image.pixels.copy(pixels, to, from, from + image.width * 4);
  }
  return { width: side, height: side, pixels };
}

// ---- outputs ---------------------------------------------------------------

const source = argument('source', path.join(projectRoot, 'build', 'logo-source.png'));
const decoded = decodePng(fs.readFileSync(source));
const { box } = cutOutRoundedTile(decoded);
console.log(`[brand] source ${decoded.width}x${decoded.height}, tile at ${box.left},${box.top} ${box.width}x${box.height}`);

// Two masters: the full lockup where there is room for it, and the mark alone
// for anywhere the app is shown at icon size.
const lockupPath = path.join(projectRoot, 'build', 'lockup-master.png');
const markPath = path.join(projectRoot, 'build', 'mark-master.png');
const macMarkPath = path.join(projectRoot, 'build', 'mac-mark-master.png');
const mark = markOnly(decoded, box);
fs.writeFileSync(lockupPath, encodePng(decoded));
fs.writeFileSync(markPath, encodePng(mark));
// Match the visual footprint of standard macOS app icons. The transparent
// margin applies only to the .icns; web, Windows and Linux assets stay intact.
fs.writeFileSync(macMarkPath, encodePng(addTransparentMargin(mark, 0.84)));

/** `sips` is on every macOS box and resamples better than anything here. */
function resize(master, target, size) {
  fs.copyFileSync(master, target);
  execFileSync('sips', ['-z', String(size), String(size), target], { stdio: 'ignore' });
}

const OUTPUTS = [
  // The app icon, the tab favicon and the touch icon are all seen small.
  ['build/icon.png', 1024, markPath],
  ['public/logo-192.png', 192, markPath],
  ['public/favicon.png', 64, markPath],
  // The home header has room for the wordmark.
  ['public/logo.png', 512, lockupPath],
];
for (const [relative, size, master] of OUTPUTS) {
  const target = path.join(projectRoot, relative);
  resize(master, target, size);
  console.log(`[brand] wrote ${relative} (${size}px, ${master === markPath ? 'mark' : 'lockup'})`);
}

const ICONSET = [16, 32, 64, 128, 256, 512, 1024];
const iconset = path.join(projectRoot, 'build', 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
for (const size of ICONSET) {
  if (size <= 512) resize(macMarkPath, path.join(iconset, `icon_${size}x${size}.png`), size);
  if (size >= 32) resize(macMarkPath, path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), size);
}

function writeIcns(target) {
  const representations = [
    ['ic04', 'icon_16x16.png'],
    ['ic11', 'icon_16x16@2x.png'],
    ['ic05', 'icon_32x32.png'],
    ['ic12', 'icon_32x32@2x.png'],
    ['ic07', 'icon_128x128.png'],
    ['ic13', 'icon_128x128@2x.png'],
    ['ic08', 'icon_256x256.png'],
    ['ic14', 'icon_256x256@2x.png'],
    ['ic09', 'icon_512x512.png'],
    ['ic10', 'icon_512x512@2x.png'],
  ];
  const chunks = representations.map(([type, file]) => {
    const data = fs.readFileSync(path.join(iconset, file));
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(data.length + header.length, 4);
    return Buffer.concat([header, data]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(header.length + chunks.reduce((total, item) => total + item.length, 0), 4);
  fs.writeFileSync(target, Buffer.concat([header, ...chunks]));
}

writeIcns(path.join(projectRoot, 'build', 'icon.icns'));
console.log('[brand] wrote build/icon.icns');

/**
 * Writes a Windows .ico.
 *
 * An .ico is a directory of images, and since Vista each entry may simply be a
 * PNG — so this needs no image tooling beyond what is already here, and the
 * Windows icon no longer has to be produced on a different machine.
 */
function writeIco(target, sizes) {
  const images = sizes.map((size) => {
    const scratch = path.join(projectRoot, 'build', `.ico-${size}.png`);
    resize(markPath, scratch, size);
    const data = fs.readFileSync(scratch);
    fs.rmSync(scratch, { force: true });
    return { size, data };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0; anything larger has no representation here.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette colours
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  fs.writeFileSync(target, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
}

writeIco(path.join(projectRoot, 'build', 'icon.ico'), [16, 24, 32, 48, 64, 128, 256]);
console.log('[brand] wrote build/icon.ico');

fs.rmSync(lockupPath, { force: true });
fs.rmSync(markPath, { force: true });
fs.rmSync(macMarkPath, { force: true });
console.log('[brand] done');
