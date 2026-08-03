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

// ---- outputs ---------------------------------------------------------------

const source = argument('source', path.join(projectRoot, 'build', 'logo-source.png'));
const decoded = decodePng(fs.readFileSync(source));
const { box } = cutOutRoundedTile(decoded);
console.log(`[brand] source ${decoded.width}x${decoded.height}, tile at ${box.left},${box.top} ${box.width}x${box.height}`);

const masterPath = path.join(projectRoot, 'build', 'icon-master.png');
fs.writeFileSync(masterPath, encodePng(decoded));

/** `sips` is on every macOS box and resamples better than anything here. */
function resize(target, size) {
  fs.copyFileSync(masterPath, target);
  execFileSync('sips', ['-z', String(size), String(size), target], { stdio: 'ignore' });
}

const OUTPUTS = [
  ['build/icon.png', 1024],
  ['public/logo.png', 512],
  ['public/logo-192.png', 192],
  ['public/favicon.png', 64],
];
for (const [relative, size] of OUTPUTS) {
  const target = path.join(projectRoot, relative);
  resize(target, size);
  console.log(`[brand] wrote ${relative} (${size}px)`);
}

const ICONSET = [16, 32, 64, 128, 256, 512, 1024];
const iconset = path.join(projectRoot, 'build', 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
for (const size of ICONSET) {
  if (size <= 512) resize(path.join(iconset, `icon_${size}x${size}.png`), size);
  if (size >= 32) resize(path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`), size);
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(projectRoot, 'build', 'icon.icns')]);
console.log('[brand] wrote build/icon.icns');

fs.rmSync(masterPath, { force: true });
console.log('[brand] done — build/icon.ico must be regenerated on Windows or with a converter');
