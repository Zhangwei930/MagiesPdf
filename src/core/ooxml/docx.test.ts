import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { paragraphsToDocx, escapeXml } from './docx.ts';
import { zipStore, zipRead, crc32 } from './zip.ts';

function deflatedZip(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const compressed = new Uint8Array(deflateRawSync(data));
  const local = new Uint8Array(30 + nameBytes.length + compressed.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(8, 8, true);
  localView.setUint32(18, compressed.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(compressed, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(10, 8, true);
  centralView.setUint32(20, compressed.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, nameBytes.length, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);

  const archive = new Uint8Array(local.length + central.length + end.length);
  archive.set(local, 0);
  archive.set(central, local.length);
  archive.set(end, local.length + central.length);
  return archive;
}

describe('escapeXml', () => {
  it('escapes the five special characters', () => {
    assert.equal(escapeXml(`a&b<c>d"e`), 'a&amp;b&lt;c&gt;d&quot;e');
  });
});

describe('zipStore', () => {
  it('emits a ZIP with local headers and an end-of-central-directory', () => {
    const bytes = zipStore([{ name: 'hello.txt', data: 'hi' }]);
    // Local file header signature
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
    assert.equal(bytes[2], 0x03);
    assert.equal(bytes[3], 0x04);
    // EOCD signature somewhere near the end
    const eocd = bytes.length - 22;
    assert.equal(bytes[eocd], 0x50);
    assert.equal(bytes[eocd + 1], 0x4b);
    assert.equal(bytes[eocd + 2], 0x05);
    assert.equal(bytes[eocd + 3], 0x06);
  });

  it('computes a known CRC-32', () => {
    // CRC of "123456789" is the common check value 0xcbf43926.
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  });

  it('round-trips entries through zipRead', () => {
    const bytes = zipStore([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/b.txt', data: 'world' },
    ]);
    const files = zipRead(bytes);
    assert.equal(new TextDecoder().decode(files.get('a.txt') as Uint8Array), 'hello');
    assert.equal(new TextDecoder().decode(files.get('dir/b.txt') as Uint8Array), 'world');
  });

  it('rejects an entry whose expanded size exceeds the configured budget', () => {
    const archive = deflatedZip('large.txt', new Uint8Array(4096).fill(65));
    assert.throws(
      () => zipRead(archive, { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 2048 }),
      /ZIP entry exceeds|ZIP expanded data exceeds/i,
    );
  });

  it('rejects archives with too many entries before reading their contents', () => {
    const archive = zipStore([
      { name: 'a.txt', data: 'one' },
      { name: 'b.txt', data: 'two' },
    ]);
    assert.throws(
      () => zipRead(archive, { maxEntries: 1, maxEntryBytes: 1024, maxTotalBytes: 2048 }),
      /too many ZIP entries/i,
    );
  });
});

describe('paragraphsToDocx', () => {
  it('builds a package that starts with the ZIP magic and contains the text', () => {
    const bytes = paragraphsToDocx(['Hello', 'World']);
    assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b]);
    const asString = new TextDecoder().decode(bytes);
    assert.ok(asString.includes('Hello'));
    assert.ok(asString.includes('World'));
    assert.ok(asString.includes('word/document.xml'));
  });

  it('preserves blank paragraphs as empty <w:p/>', () => {
    const bytes = paragraphsToDocx(['A', '', 'B']);
    const asString = new TextDecoder().decode(bytes);
    assert.ok(asString.includes('<w:p/>'));
  });
});
