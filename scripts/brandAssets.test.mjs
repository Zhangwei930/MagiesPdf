import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';

const projectRoot = path.resolve(import.meta.dirname, '..');

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function alphaBoundsFromPng(png, name) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    chunks.push({
      type: png.toString('latin1', offset + 4, offset + 8),
      data: png.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12;
  }

  const header = chunks.find((chunk) => chunk.type === 'IHDR')?.data;
  assert.ok(header, `${name} has no PNG header`);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.equal(header[8], 8, `${name} must use 8-bit channels`);
  assert.equal(header[9], 6, `${name} must use RGBA pixels`);
  assert.equal(header[12], 0, `${name} must not be interlaced`);

  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
  const previous = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    raw.copy(line, 0, row + 1, row + 1 + stride);
    for (let byte = 0; byte < stride; byte += 1) {
      const before = byte >= 4 ? line[byte - 4] : 0;
      const above = previous[byte];
      const aboveBefore = byte >= 4 ? previous[byte - 4] : 0;
      if (raw[row] === 1) line[byte] = (line[byte] + before) & 255;
      else if (raw[row] === 2) line[byte] = (line[byte] + above) & 255;
      else if (raw[row] === 3) line[byte] = (line[byte] + ((before + above) >> 1)) & 255;
      else if (raw[row] === 4) line[byte] = (line[byte] + paeth(before, above, aboveBefore)) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      if (line[x * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
    line.copy(previous);
  }

  assert.ok(right >= left && bottom >= top, `${name} has no visible pixels`);
  return { width, height, left, top, right, bottom };
}

function alphaBounds(file) {
  return alphaBoundsFromPng(fs.readFileSync(file), file);
}

function assertMacIconFootprint(bounds, name) {
  const visibleWidth = bounds.right - bounds.left + 1;
  const visibleHeight = bounds.bottom - bounds.top + 1;
  assert.ok(visibleWidth / bounds.width >= 0.8 && visibleWidth / bounds.width <= 0.88, `${name} width is not near 84%`);
  assert.ok(visibleHeight / bounds.height >= 0.8 && visibleHeight / bounds.height <= 0.88, `${name} height is not near 84%`);
  assert.ok(Math.abs(bounds.left - (bounds.width - 1 - bounds.right)) <= 1, `${name} is not horizontally centred`);
  assert.ok(Math.abs(bounds.top - (bounds.height - 1 - bounds.bottom)) <= 1, `${name} is not vertically centred`);
}

describe('macOS app icon sizing', () => {
  it('centres every iconset image on an 84% visual footprint', () => {
    const iconset = path.join(projectRoot, 'build', 'icon.iconset');
    const files = fs.readdirSync(iconset).filter((file) => file.endsWith('.png'));
    assert.ok(files.length > 0, 'macOS iconset must contain PNG assets');

    for (const file of files) {
      assertMacIconFootprint(alphaBounds(path.join(iconset, file)), file);
    }
  });

  it('packages the padded raster sizes into the macOS icns', () => {
    const icns = fs.readFileSync(path.join(projectRoot, 'build', 'icon.icns'));
    assert.equal(icns.toString('ascii', 0, 4), 'icns');
    assert.equal(icns.readUInt32BE(4), icns.length);

    let offset = 8;
    let pngCount = 0;
    while (offset < icns.length) {
      const type = icns.toString('ascii', offset, offset + 4);
      const length = icns.readUInt32BE(offset + 4);
      const data = icns.subarray(offset + 8, offset + length);
      if (data.subarray(1, 4).toString('ascii') === 'PNG') {
        assertMacIconFootprint(alphaBoundsFromPng(data, `icon.icns ${type}`), `icon.icns ${type}`);
        pngCount += 1;
      }
      offset += length;
    }
    assert.equal(pngCount, 10, 'icon.icns must contain all ten standard raster representations');
  });
});
