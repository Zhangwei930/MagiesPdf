import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildManifest, buildRanges, manifestSource, readCoverage, readFaces } from './onlyofficeFonts.mjs';

/**
 * The engine is handed its fonts as a manifest, not as a directory.
 *
 * It reads two globals: the files it may fetch, and one row per family saying
 * which file and which face inside it carries each of the four styles. A row
 * that points at the wrong file is a document that renders in the wrong
 * typeface; a row that points at nothing is a document that does not render at
 * all. So the mapping is built here, where it can be tested, rather than being
 * whatever a font happened to be called.
 */

/** A font file with only the tables the manifest is built from. */
function sfnt({ family, subfamily, typographic = '', bold = false, italic = false }) {
  const names = [
    [1, family],
    [2, subfamily],
    ...(typographic ? [[16, typographic]] : []),
  ];

  // The name table: a header, one record per name, then the strings.
  const strings = names.map(([, value]) => Buffer.from(value, 'utf16le').swap16());
  const records = Buffer.alloc(12 * names.length);
  let at = 0;
  names.forEach(([id], index) => {
    const record = records.subarray(12 * index);
    record.writeUInt16BE(3, 0); // Windows
    record.writeUInt16BE(1, 2); // UCS-2
    record.writeUInt16BE(0x0409, 4);
    record.writeUInt16BE(id, 6);
    record.writeUInt16BE(strings[index].length, 8);
    record.writeUInt16BE(at, 10);
    at += strings[index].length;
  });
  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(names.length, 2);
  header.writeUInt16BE(6 + records.length, 4);
  const nameTable = Buffer.concat([header, records, ...strings]);

  // The head table, of which only macStyle is read.
  const headTable = Buffer.alloc(54);
  headTable.writeUInt16BE((bold ? 1 : 0) | (italic ? 2 : 0), 44);

  const tables = [['head', headTable], ['name', nameTable]];
  const offsets = Buffer.alloc(12 + 16 * tables.length);
  offsets.writeUInt32BE(0x00010000, 0);
  offsets.writeUInt16BE(tables.length, 4);

  let cursor = offsets.length;
  const bodies = [];
  tables.forEach(([tag, table], index) => {
    const entry = offsets.subarray(12 + 16 * index);
    entry.write(tag, 0, 'ascii');
    entry.writeUInt32BE(cursor, 8);
    entry.writeUInt32BE(table.length, 12);
    cursor += table.length;
    bodies.push(table);
  });

  return Buffer.concat([offsets, ...bodies]);
}

/** A font carrying only a format 4 character map over `segments`. */
function cmapFont(segments) {
  const all = [...segments, [0xffff, 0xffff]];
  const count = all.length;
  const sub = Buffer.alloc(16 + 8 * count);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(2 * count, 6);
  all.forEach(([, last], index) => sub.writeUInt16BE(last, 14 + 2 * index));
  all.forEach(([first], index) => sub.writeUInt16BE(first, 16 + 2 * count + 2 * index));

  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(3, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(12, 8);
  const cmap = Buffer.concat([header, sub]);

  const offsets = Buffer.alloc(12 + 16);
  offsets.writeUInt32BE(0x00010000, 0);
  offsets.writeUInt16BE(1, 4);
  offsets.write('cmap', 12, 'ascii');
  offsets.writeUInt32BE(offsets.length, 20);
  offsets.writeUInt32BE(cmap.length, 24);
  return Buffer.concat([offsets, cmap]);
}

describe('reading a font file', () => {
  it('takes the family and the style it carries', () => {
    const faces = readFaces(sfnt({ family: 'Liberation Serif', subfamily: 'Bold Italic', bold: true, italic: true }));
    assert.deepEqual(faces, [{ family: 'Liberation Serif', bold: true, italic: true, faceIndex: 0 }]);
  });

  /**
   * A family with more than four styles splits into several under the name in
   * nameID 1 — "Noto Sans Light" — while nameID 16 keeps them together. The
   * typographic name is the one the document refers to.
   */
  it('prefers the typographic family when a font has one', () => {
    const faces = readFaces(sfnt({ family: 'Noto Sans Light', subfamily: 'Regular', typographic: 'Noto Sans' }));
    assert.equal(faces[0].family, 'Noto Sans');
  });

  it('reports nothing for something that is not a font', () => {
    assert.deepEqual(readFaces(Buffer.from('not a font at all')), []);
  });
});

describe('building the manifest', () => {
  const files = [
    { name: 'Lib-Regular.ttf', faces: [{ family: 'Liberation Serif', bold: false, italic: false, faceIndex: 0 }] },
    { name: 'Lib-Bold.ttf', faces: [{ family: 'Liberation Serif', bold: true, italic: false, faceIndex: 0 }] },
    { name: 'Open-Italic.ttf', faces: [{ family: 'Open Sans', bold: false, italic: true, faceIndex: 0 }] },
  ];

  it('lists every file, in the order the rows index into', () => {
    const { files: listed } = buildManifest(files);
    assert.deepEqual(listed, ['Lib-Regular.ttf', 'Lib-Bold.ttf', 'Open-Italic.ttf']);
  });

  it('points each style at the file that carries it', () => {
    const { infos } = buildManifest(files);
    const serif = infos.find((row) => row[0] === 'Liberation Serif');
    assert.deepEqual(serif, ['Liberation Serif', 0, 0, -1, -1, 1, 0, -1, -1]);
  });

  /** -1 is how the engine is told a style is absent; 0 would be a real file. */
  it('marks a style the family does not have as absent', () => {
    const { infos } = buildManifest(files);
    const open = infos.find((row) => row[0] === 'Open Sans');
    assert.deepEqual(open, ['Open Sans', -1, -1, 2, 0, -1, -1, -1, -1]);
  });

  it('orders families by name so the manifest does not churn', () => {
    const { infos } = buildManifest([...files].reverse());
    assert.deepEqual(infos.map((row) => row[0]), ['Liberation Serif', 'Open Sans']);
  });

  /**
   * The engine drops the ASCW3 row while building its own list, without
   * advancing the index it is filling — so every family after it sits one
   * lower there than here. Anything that indexes families by position, which
   * the character fallback table does, then points at the wrong font, and the
   * engine throws the whole table away when one of them runs off the end.
   *
   * The row only tells the engine which file holds its symbol font, and the
   * name it falls back on is the name that file already has.
   */
  it('leaves out the row the engine would drop', () => {
    const { infos } = buildManifest([
      { name: 'ASC.ttf', faces: [{ family: 'ASCW3', bold: false, italic: false, faceIndex: 0 }] },
      ...files,
    ]);
    assert.ok(!infos.some((row) => row[0] === 'ASCW3'), 'the engine indexes families without it');
  });

  it('leaves out a file that carries no readable face', () => {
    const { files: listed, infos } = buildManifest([...files, { name: 'broken.ttf', faces: [] }]);
    assert.ok(!listed.includes('broken.ttf'));
    assert.equal(infos.length, 2);
  });
});

/**
 * What the engine reaches for when the font a document names does not have the
 * character being typeset.
 *
 * Without it there is no fallback at all: a Chinese document whose font is not
 * installed renders as a page of empty boxes, which is what the reader sees
 * rather than an error. The table is a flat list of
 * `[first, last, familyIndex]`, and the engine looks a character up in it.
 */
describe('the character fallback table', () => {
  const wide = { name: 'wide.ttf', faces: [{ family: 'Wide', bold: false, italic: false, faceIndex: 0 }] };
  const narrow = { name: 'narrow.ttf', faces: [{ family: 'Narrow', bold: false, italic: false, faceIndex: 0 }] };
  const coverage = new Map([
    ['wide.ttf', [[0x20, 0x7e], [0x4e00, 0x9fff]]],
    ['narrow.ttf', [[0x20, 0x7e]]],
  ]);

  it('sends a character to a family that has it', () => {
    const manifest = buildManifest([wide, narrow]);
    const ranges = buildRanges(manifest, [wide, narrow], coverage);

    const cjk = [];
    for (let at = 0; at < ranges.length; at += 3) {
      if (ranges[at] <= 0x4e00 && 0x4e00 <= ranges[at + 1]) cjk.push(ranges[at + 2]);
    }
    assert.equal(cjk.length, 1, 'a character belongs to exactly one range');
    assert.equal(manifest.infos[cjk[0]][0], 'Wide', 'only one family covers it');
  });

  /** A character no font has must not claim a family that cannot draw it. */
  it('leaves a character nothing covers out', () => {
    const ranges = buildRanges(buildManifest([wide, narrow]), [wide, narrow], coverage);
    for (let at = 0; at < ranges.length; at += 3) {
      assert.ok(ranges[at + 1] < 0xe000 || ranges[at] > 0xf8ff, 'the private use area is nobody\u2019s');
    }
  });

  it('prefers the family that covers more, so a fallback is a broad one', () => {
    const manifest = buildManifest([narrow, wide]);
    const ranges = buildRanges(manifest, [narrow, wide], coverage);
    const latin = [];
    for (let at = 0; at < ranges.length; at += 3) {
      if (ranges[at] <= 0x41 && 0x41 <= ranges[at + 1]) latin.push(manifest.infos[ranges[at + 2]][0]);
    }
    assert.deepEqual(latin, ['Wide']);
  });

  it('is triples, in order, and does not overlap', () => {
    const ranges = buildRanges(buildManifest([wide, narrow]), [wide, narrow], coverage);
    assert.equal(ranges.length % 3, 0);
    for (let at = 3; at < ranges.length; at += 3) {
      assert.ok(ranges[at] > ranges[at - 2], 'ranges are sorted and disjoint');
    }
  });
});

describe('reading what a font covers', () => {
  /** Format 4 is the segmented mapping every text font carries. */
  it('reads the segments of a format 4 map', () => {
    assert.deepEqual(readCoverage(cmapFont([[0x41, 0x5a], [0x61, 0x7a]])), [[0x41, 0x5a], [0x61, 0x7a]]);
  });

  it('reads nothing from a font with no map', () => {
    assert.deepEqual(readCoverage(Buffer.from('not a font')), []);
  });
});

describe('the manifest source', () => {
  const source = manifestSource(buildManifest([
    { name: 'Lib-Regular.ttf', faces: [{ family: 'Liberation Serif', bold: false, italic: false, faceIndex: 0 }] },
  ]));

  it('defines the globals the engine reads', () => {
    assert.match(source, /window\["__fonts_files"\]\s*=/);
    assert.match(source, /window\["__fonts_infos"\]\s*=/);
  });

  /**
   * The engine reads the font selection table as `window.g_fonts_selection_bin`
   * and skips it when it is empty — but the check is `!= ""`, which undefined
   * passes. Leaving it undefined therefore does not skip the table, it decodes
   * one that is not there, and the editor dies before it loads a single font.
   */
  it('declares the selection table even when there is none', () => {
    assert.match(source, /window\["g_fonts_selection_bin"\]\s*=\s*""/);
    const window = {};
    new Function('window', source)(window);
    assert.equal(window.g_fonts_selection_bin, '');
  });

  it('is valid javascript that produces them', () => {
    const window = {};
    new Function('window', source)(window);
    assert.deepEqual(window.__fonts_files, ['Lib-Regular.ttf']);
    assert.deepEqual(window.__fonts_infos, [['Liberation Serif', 0, 0, -1, -1, -1, -1, -1, -1]]);
  });

  it('carries the character fallback table when there is one', () => {
    const withRanges = manifestSource(
      buildManifest([{ name: 'a.ttf', faces: [{ family: 'A', bold: false, italic: false, faceIndex: 0 }] }]),
      [0x20, 0x7e, 0],
    );
    const window = {};
    new Function('window', withRanges)(window);
    assert.deepEqual(window.__fonts_ranges, [0x20, 0x7e, 0]);
  });
});
