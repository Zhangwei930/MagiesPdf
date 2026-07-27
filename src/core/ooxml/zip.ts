/**
 * Minimal ZIP helpers for Office Open XML packages.
 *
 * Writing uses the store method only (no compression). Reading supports store
 * and deflate so real .pptx/.docx files from other apps can be opened.
 */

import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
}

export interface ZipReadLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

const DEFAULT_READ_LIMITS: ZipReadLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes =
      typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length + dataBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true); // store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = locals.reduce((n, l) => n + l.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const local of locals) {
    out.set(local, pos);
    pos += local.length;
  }
  for (const central of centrals) {
    out.set(central, pos);
    pos += central.length;
  }
  out.set(end, pos);
  return out;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] as number;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Reads a ZIP archive into a name → bytes map.
 * Directory entries are skipped. Unsupported compression methods throw.
 */
export function zipRead(
  bytes: Uint8Array,
  limits: ZipReadLimits = DEFAULT_READ_LIMITS,
): Map<string, Uint8Array> {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error('Not a ZIP archive');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory not found');

  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount > limits.maxEntries) {
    throw new Error(`Too many ZIP entries (${entryCount}; limit ${limits.maxEntries})`);
  }
  let offset = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let totalBytes = 0;

  for (let n = 0; n < entryCount; n += 1) {
    if (offset < 0 || offset + 46 > bytes.length) {
      throw new Error('ZIP central directory is outside the archive');
    }
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('ZIP central directory is corrupt');
    }
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const expandedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const centralEnd = offset + 46 + nameLen + extraLen + commentLen;
    if (centralEnd > bytes.length) throw new Error('ZIP central directory entry is truncated');
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (expandedSize > limits.maxEntryBytes) {
      throw new Error(`ZIP entry exceeds expanded-size limit: ${name}`);
    }
    if (totalBytes + expandedSize > limits.maxTotalBytes) {
      throw new Error('ZIP expanded data exceeds total-size limit');
    }

    if (localOffset < 0 || localOffset + 30 > bytes.length) {
      throw new Error(`ZIP local header is outside the archive for ${name}`);
    }
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`ZIP local header missing for ${name}`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart > bytes.length || compSize > bytes.length - dataStart) {
      throw new Error(`ZIP data is truncated for ${name}`);
    }
    const compressed = bytes.subarray(dataStart, dataStart + compSize);

    let data: Uint8Array;
    if (method === 0) {
      data = compressed.slice();
    } else if (method === 8) {
      try {
        data = new Uint8Array(
          inflateRawSync(compressed, {
            maxOutputLength: Math.min(
              limits.maxEntryBytes,
              limits.maxTotalBytes - totalBytes,
            ),
          }),
        );
      } catch (cause) {
        throw new Error(
          `ZIP entry exceeds expanded-size limit or is corrupt: ${name}`,
          { cause },
        );
      }
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    if (data.length > limits.maxEntryBytes || totalBytes + data.length > limits.maxTotalBytes) {
      throw new Error(`ZIP expanded data exceeds limit for ${name}`);
    }
    totalBytes += data.length;
    out.set(name, data);
  }

  return out;
}
