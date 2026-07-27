import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { paragraphsToDocx, escapeXml } from './docx.ts';
import { zipStore, zipRead, crc32 } from './zip.ts';

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
