import fs from 'node:fs';
import path from 'node:path';

/**
 * Builds the font manifest the editor engine reads.
 *
 * The engine does not look in a directory. It reads two globals: the files it
 * may fetch, and one row per family saying which file carries the regular,
 * italic, bold and bold-italic of that family. Document Server generates this
 * with `allfontsgen`, which ships only as a Linux binary — so this does the
 * same job from the font files themselves.
 *
 * Doing it here also settles a question the desktop build left open. Its
 * manifest listed whatever fonts happened to be on the machine that generated
 * it, by absolute path, which is neither reproducible nor something that can be
 * shipped. These are the fonts that ship with the engine, named by filename.
 */

/**
 * The engine's own symbol font, which it looks up by file rather than by
 * family — and whose row it drops from the family list without advancing the
 * index it is filling. Leaving the row out here keeps the two lists indexed
 * alike, which anything positional depends on. The engine falls back on this
 * exact filename when no row names it.
 */
const ENGINE_SYMBOL_FAMILY = 'ASCW3';

const NAME_FAMILY = 1;
const NAME_TYPOGRAPHIC_FAMILY = 16;
const MAC_STYLE_BOLD = 1;
const MAC_STYLE_ITALIC = 2;

/** Reads a name table's strings, keyed by name id. */
function readNames(view, at) {
  const count = view.readUInt16BE(at + 2);
  const storage = at + view.readUInt16BE(at + 4);
  const names = new Map();

  for (let index = 0; index < count; index += 1) {
    const record = at + 6 + 12 * index;
    const platform = view.readUInt16BE(record);
    const id = view.readUInt16BE(record + 6);
    const length = view.readUInt16BE(record + 8);
    const offset = storage + view.readUInt16BE(record + 10);
    if (offset + length > view.length) continue;

    const bytes = view.subarray(offset, offset + length);
    // Platform 3 is Windows, whose strings are UTF-16BE; platform 1 is
    // Macintosh, whose Roman encoding is close enough to latin1 for a name.
    const value = platform === 3
      ? Buffer.from(bytes).swap16().toString('utf16le')
      : bytes.toString('latin1');

    // Windows names win: a font that has both spells the family the way a
    // document written on Windows refers to it.
    if (!names.has(id) || platform === 3) names.set(id, value);
  }
  return names;
}

/** The tables of one font, by tag. */
function readTables(view, at) {
  const count = view.readUInt16BE(at + 4);
  const tables = new Map();
  for (let index = 0; index < count; index += 1) {
    const entry = at + 12 + 16 * index;
    if (entry + 16 > view.length) break;
    tables.set(view.toString('ascii', entry, entry + 4), {
      offset: view.readUInt32BE(entry + 8),
      length: view.readUInt32BE(entry + 12),
    });
  }
  return tables;
}

function readFace(view, at, faceIndex) {
  const tables = readTables(view, at);
  const name = tables.get('name');
  const head = tables.get('head');
  if (!name || name.offset + 6 > view.length) return null;

  const names = readNames(view, name.offset);
  const family = names.get(NAME_TYPOGRAPHIC_FAMILY) || names.get(NAME_FAMILY);
  if (!family) return null;

  // macStyle, rather than the OS/2 selection flags: every font has a head
  // table, and the two agree wherever both exist.
  const macStyle = head && head.offset + 46 <= view.length ? view.readUInt16BE(head.offset + 44) : 0;

  return {
    family: family.trim(),
    bold: Boolean(macStyle & MAC_STYLE_BOLD),
    italic: Boolean(macStyle & MAC_STYLE_ITALIC),
    faceIndex,
  };
}

/**
 * The faces a font file carries.
 *
 * Usually one. A collection — `.ttc` — holds several, and the manifest has to
 * name which one, because asking for face 0 of a collection whose regular is
 * face 2 renders the document in the wrong weight.
 */
export function readFaces(buffer) {
  const view = Buffer.from(buffer);
  if (view.length < 12) return [];

  const tag = view.toString('ascii', 0, 4);
  if (tag === 'ttcf') {
    const count = view.readUInt32BE(8);
    const faces = [];
    for (let index = 0; index < count; index += 1) {
      const at = 12 + 4 * index;
      if (at + 4 > view.length) break;
      const face = readFace(view, view.readUInt32BE(at), index);
      if (face) faces.push(face);
    }
    return faces;
  }

  const version = view.readUInt32BE(0);
  if (version !== 0x00010000 && tag !== 'OTTO' && tag !== 'true') return [];
  const face = readFace(view, 0, 0);
  return face ? [face] : [];
}

/** The ranges of characters a character map covers. */
function readCmapRanges(view, at) {
  const format = view.readUInt16BE(at);
  const ranges = [];

  if (format === 4) {
    const segments = view.readUInt16BE(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + 2 * segments + 2;
    for (let index = 0; index < segments; index += 1) {
      if (starts + 2 * index + 2 > view.length) break;
      const first = view.readUInt16BE(starts + 2 * index);
      const last = view.readUInt16BE(ends + 2 * index);
      // The final segment is the 0xFFFF terminator, not coverage.
      if (first > last || first === 0xffff) continue;
      ranges.push([first, last]);
    }
    return ranges;
  }

  if (format === 12) {
    const groups = view.readUInt32BE(at + 12);
    for (let index = 0; index < groups; index += 1) {
      const group = at + 16 + 12 * index;
      if (group + 12 > view.length) break;
      const first = view.readUInt32BE(group);
      const last = view.readUInt32BE(group + 4);
      if (first <= last) ranges.push([first, last]);
    }
    return ranges;
  }

  return ranges;
}

/**
 * What characters a font can draw.
 *
 * Read from the character map rather than the OS/2 range bits, which say which
 * scripts a font claims rather than which characters it actually has — and a
 * fallback that claims a character it cannot draw renders an empty box.
 */
export function readCoverage(buffer) {
  const view = Buffer.from(buffer);
  if (view.length < 12) return [];

  const tag = view.toString('ascii', 0, 4);
  const version = view.readUInt32BE(0);
  const at = tag === 'ttcf' ? (view.length >= 16 ? view.readUInt32BE(12) : 0) : 0;
  if (tag !== 'ttcf' && version !== 0x00010000 && tag !== 'OTTO' && tag !== 'true') return [];

  const cmap = readTables(view, at).get('cmap');
  if (!cmap || cmap.offset + 4 > view.length) return [];

  const count = view.readUInt16BE(cmap.offset + 2);
  let best = -1;
  let bestScore = -1;
  for (let index = 0; index < count; index += 1) {
    const record = cmap.offset + 4 + 8 * index;
    if (record + 8 > view.length) break;
    const platform = view.readUInt16BE(record);
    const encoding = view.readUInt16BE(record + 2);
    // Prefer the map that covers the most: full Unicode over the basic plane.
    const score = platform === 3 && encoding === 10 ? 3
      : platform === 0 && encoding >= 4 ? 3
        : platform === 3 && encoding === 1 ? 2
          : platform === 0 ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = cmap.offset + view.readUInt32BE(record + 4);
    }
  }
  if (best < 0 || best + 2 > view.length) return [];

  return readCmapRanges(view, best).sort(([left], [right]) => left - right);
}

/** The neutral answer for a font that carries no OS/2 table at all. */
const DEFAULT_METRICS = Object.freeze({
  panose: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  unicodeRange: [0, 0, 0, 0],
  codePageRange: [0, 0],
  weight: 400,
  width: 5,
  familyClass: 0,
  avgCharWidth: 0,
  ascent: 0,
  descent: 0,
  lineGap: 0,
  xHeight: 0,
  capHeight: 0,
  type: 0,
  fixed: false,
});

function readMetricsAt(view, at) {
  const tables = readTables(view, at);
  const os2 = tables.get('OS/2');
  const post = tables.get('post');

  const fixed = post && post.offset + 16 <= view.length
    ? view.readUInt32BE(post.offset + 12) !== 0
    : false;

  if (!os2 || os2.offset + 78 > view.length) return { ...DEFAULT_METRICS, fixed };

  const base = os2.offset;
  const version = view.readUInt16BE(base);
  const at32 = (offset) => (base + offset + 4 <= view.length ? view.readUInt32BE(base + offset) : 0);
  const at16 = (offset) => (base + offset + 2 <= view.length ? view.readInt16BE(base + offset) : 0);

  return {
    panose: Array.from({ length: 10 }, (unused, index) => view.readUInt8(base + 32 + index)),
    unicodeRange: [at32(42), at32(46), at32(50), at32(54)],
    // Only version 1 and later carry the code pages, which is what says a font
    // covers a script rather than merely a range of characters.
    codePageRange: version >= 1 ? [at32(78), at32(82)] : [0, 0],
    weight: view.readUInt16BE(base + 4),
    width: view.readUInt16BE(base + 6),
    familyClass: at16(30),
    avgCharWidth: at16(2),
    ascent: at16(68),
    descent: at16(70),
    lineGap: at16(72),
    xHeight: version >= 2 ? at16(86) : 0,
    capHeight: version >= 2 ? at16(88) : 0,
    type: view.readUInt16BE(base + 8),
    fixed,
  };
}

/**
 * The metrics the engine compares fonts by when the one a document names is
 * not there. All of them come from OS/2, which most fonts have and a few do
 * not — hence a neutral answer rather than a failure.
 */
export function readMetrics(buffer, faceIndex = 0) {
  const view = Buffer.from(buffer);
  if (view.length < 12) return { ...DEFAULT_METRICS };

  const tag = view.toString('ascii', 0, 4);
  if (tag === 'ttcf') {
    const offset = 12 + 4 * faceIndex;
    if (offset + 4 > view.length) return { ...DEFAULT_METRICS };
    return readMetricsAt(view, view.readUInt32BE(offset));
  }
  return readMetricsAt(view, 0);
}

/** Which of the four style slots a face fills. */
function slotOf(face) {
  if (face.bold && face.italic) return 3;
  if (face.bold) return 2;
  if (face.italic) return 1;
  return 0;
}

/**
 * Turns read font files into the manifest.
 *
 * `files` are `{ name, faces }`. A style a family does not have is -1, which
 * is how the engine is told it is absent — 0 would name a real file.
 */
export function buildManifest(files) {
  const listed = files.filter((file) => file.faces.length > 0);
  const names = listed.map((file) => file.name);

  const families = new Map();
  listed.forEach((file, fileIndex) => {
    file.faces.forEach((face) => {
      if (!families.has(face.family)) {
        families.set(face.family, [-1, -1, -1, -1, -1, -1, -1, -1]);
      }
      const slot = slotOf(face) * 2;
      const row = families.get(face.family);
      // First file wins: the fonts are walked in a fixed order, so a family
      // whose style appears twice resolves the same way every time.
      if (row[slot] === -1) {
        row[slot] = fileIndex;
        row[slot + 1] = face.faceIndex;
      }
    });
  });

  const infos = [...families.entries()]
    .filter(([family]) => family !== ENGINE_SYMBOL_FAMILY)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([family, row]) => [family, ...row]);

  return { files: names, infos };
}

/**
 * The table the engine reads when the font a document names cannot draw a
 * character.
 *
 * One family per character, chosen from the families that cover it, preferring
 * the one that covers the most — a broad fallback is a better guess than a
 * narrow one, and it keeps the table short. Characters nothing covers are left
 * out: naming a family that cannot draw them only turns a missing glyph into a
 * wrong one.
 */
export function buildRanges({ files, infos }, read, coverage) {
  const familyIndex = new Map(infos.map((row, index) => [row[0], index]));
  const fileOf = new Map(read.filter((file) => file.faces.length > 0).map((file) => [file.name, file]));

  // How much each family covers, and where — taken from whichever of its files
  // is listed first, which is the file its regular style points at.
  const spans = new Map();
  files.forEach((name) => {
    const file = fileOf.get(name);
    const ranges = coverage.get(name) ?? [];
    const size = ranges.reduce((total, [first, last]) => total + (last - first + 1), 0);
    file?.faces.forEach((face) => {
      const index = familyIndex.get(face.family);
      if (index === undefined) return;
      const held = spans.get(index);
      if (!held || held.size < size) spans.set(index, { ranges, size });
    });
  });

  // Sweep the boundaries rather than every character: the table is built from
  // a few thousand segments, not from a million codepoints.
  const edges = new Set([0]);
  spans.forEach(({ ranges }) => ranges.forEach(([first, last]) => {
    edges.add(first);
    edges.add(last + 1);
  }));

  const ordered = [...spans.entries()].sort((left, right) => right[1].size - left[1].size || left[0] - right[0]);
  const bounds = [...edges].sort((left, right) => left - right);
  const out = [];

  for (let index = 0; index < bounds.length; index += 1) {
    const first = bounds[index];
    const last = (bounds[index + 1] ?? first + 1) - 1;
    if (last < first) continue;

    const owner = ordered.find(([, span]) => span.ranges.some(([from, to]) => from <= first && last <= to));
    if (!owner) continue;

    const previous = out.length - 3;
    // Merge with the segment before it when the same family continues.
    if (previous >= 0 && out[previous + 2] === owner[0] && out[previous + 1] + 1 === first) {
      out[previous + 1] = last;
      continue;
    }
    out.push(first, last, owner[0]);
  }

  return out;
}

/** A growable little-endian writer, which is the order the engine reads in. */
function writer() {
  let buffer = Buffer.alloc(1024);
  let at = 0;

  const room = (bytes) => {
    if (at + bytes <= buffer.length) return;
    const grown = Buffer.alloc(Math.max(buffer.length * 2, at + bytes));
    buffer.copy(grown);
    buffer = grown;
  };

  return {
    get length() { return at; },
    long(value) { room(4); buffer.writeInt32LE(value | 0, at); at += 4; },
    ulong(value) { room(4); buffer.writeUInt32LE(value >>> 0, at); at += 4; },
    ushort(value) { room(2); buffer.writeUInt16LE(value & 0xffff, at); at += 2; },
    byte(value) { room(1); buffer.writeUInt8(value & 0xff, at); at += 1; },
    text(value) {
      const bytes = Buffer.from(value, 'utf8');
      this.ulong(bytes.length);
      room(bytes.length);
      bytes.copy(buffer, at);
      at += bytes.length;
    },
    patchLong(position, value) { buffer.writeInt32LE(value | 0, position); },
    done() { return buffer.subarray(0, at); },
  };
}

/**
 * The table the engine maps a font's name to a file with.
 *
 * Emphatically not optional. With an empty one the engine resolves no font at
 * all — it fetches none, and every character comes out as an empty box — which
 * looks like missing fonts rather than a missing table.
 */
export function buildSelection(faces) {
  const out = writer();
  out.ulong(faces.length);

  faces.forEach((face) => {
    const lengthAt = out.length;
    out.long(0); // patched once the record's own length is known

    out.text(face.family);
    out.ulong(0); // no alternative names: the family name is the only one
    out.text(face.file);

    out.long(face.faceIndex);
    out.long(face.italic ? 1 : 0);
    out.long(face.bold ? 1 : 0);
    out.long(face.fixed ? 1 : 0);

    out.ulong(face.panose.length);
    face.panose.forEach((value) => out.byte(value));

    face.unicodeRange.forEach((value) => out.ulong(value));
    face.codePageRange.forEach((value) => out.ulong(value));

    out.ushort(face.weight);
    out.ushort(face.width);
    out.ushort(face.familyClass);
    out.ushort(1); // the format is a font file on disk, not an embedded one
    out.ushort(face.avgCharWidth);
    out.ushort(face.ascent);
    out.ushort(face.descent);
    out.ushort(face.lineGap);
    out.ushort(face.xHeight);
    out.ushort(face.capHeight);
    out.ushort(face.type);

    out.patchLong(lengthAt, out.length - lengthAt);
  });

  return out.done().toString('base64');
}

/** The manifest as the file the engine loads. */
export function manifestSource({ files, infos }, ranges = [], selection = '') {
  const rows = infos.map((row) => JSON.stringify(row)).join(',\n');
  return `// Generated by scripts/onlyofficeFonts.mjs from the fonts that ship
// with the engine. Do not edit; regenerate with \`npm run fonts:engine\`.
window["__all_fonts_js_version__"] = 2;

window["__fonts_files"] = ${JSON.stringify(files, null, 0)};

window["__fonts_infos"] = [
${rows}
];

// How the engine resolves a font's name to a file. It has to be declared even
// when empty: the engine's check is \`!= ""\`, which undefined passes, so
// leaving it out makes it decode a table that is not there and die before
// loading a font. Empty is no better — it then resolves nothing and fetches
// nothing, and every character is drawn as a box.
window["g_fonts_selection_bin"] = "${selection}";

// Which family to fall back on for a character the document's font cannot
// draw. Without it a document in a font that is not here renders as boxes.
window["__fonts_ranges"] = ${JSON.stringify(ranges)};
`;
}

/**
 * The scales the font dropdown looks for its preview strip at, and the two
 * postfixes: the East Asian strip is used when the interface is in Chinese,
 * Japanese or Korean.
 */
const THUMBNAIL_SCALES = ['', '@1.25x', '@1.5x', '@1.75x', '@2x'];
const THUMBNAIL_WIDTH = 300;
const THUMBNAIL_ROW_HEIGHT = 28;

/** Every strip the dropdown may ask for. */
export function thumbnailSpriteNames() {
  const names = [];
  for (const postfix of ['', '_ea']) {
    for (const scale of THUMBNAIL_SCALES) {
      names.push(`fonts_thumbnail${postfix}${scale}.png.bin`);
    }
  }
  return names;
}

/**
 * A blank strip of font previews.
 *
 * The dropdown reads the strip's width, row height and row count out of the
 * first twelve bytes and then decodes runs: a zero byte followed by a length
 * is that many transparent pixels. Absent, the width reads as zero and asking
 * the canvas for an image that wide throws — which the editor reports as a
 * failure to work with the document, and picking a font stops working.
 *
 * The previews come out blank. Generating real ones is the job of a tool that
 * ships only for Linux; a blank strip is a plain loss next to a dropdown that
 * cannot be opened.
 */
export function thumbnailSprite({ width, rowHeight, count }) {
  const header = Buffer.alloc(12);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rowHeight, 4);
  header.writeUInt32BE(count, 8);

  const pixels = width * rowHeight * count;
  const runs = [];
  for (let left = pixels; left > 0; left -= 255) {
    runs.push(0, Math.min(255, left));
  }
  return Buffer.concat([header, Buffer.from(runs)]);
}

/** Reads every font in `directory` in a fixed order. */
export function readFontDirectory(directory) {
  return fs.readdirSync(directory)
    .filter((name) => /\.(ttf|ttc|otf)$/i.test(name))
    .sort()
    .map((name) => {
      try {
        return { name, faces: readFaces(fs.readFileSync(path.join(directory, name))) };
      } catch {
        return { name, faces: [] };
      }
    });
}

/**
 * Regenerates the manifest in place.
 *
 * The fonts and the manifest have to be generated together: the rows are
 * indexes into the file list, so a manifest written against a different set of
 * fonts points at the wrong ones.
 */
function main() {
  // The javascript half, which every target links to rather than copies.
  const root = process.argv[2] ?? 'vendor/onlyoffice/shared/web';
  const fonts = path.join(root, 'fonts');
  const manifest = path.join(root, 'sdkjs', 'common', 'AllFonts.js');

  const files = readFontDirectory(fonts);
  const built = buildManifest(files);
  const coverage = new Map(built.files.map((name) => [
    name,
    readCoverage(fs.readFileSync(path.join(fonts, name))),
  ]));
  const ranges = buildRanges(built, files, coverage);

  // One record per face, named by the family it belongs to: this is what the
  // engine looks a font up in.
  const selection = buildSelection(files.flatMap((file) => file.faces.map((face) => {
    const bytes = fs.readFileSync(path.join(fonts, file.name));
    return {
      family: face.family,
      file: file.name,
      faceIndex: face.faceIndex,
      bold: face.bold,
      italic: face.italic,
      ...readMetrics(bytes, face.faceIndex),
    };
  })));

  fs.writeFileSync(manifest, manifestSource(built, ranges, selection));

  // The dropdown's preview strip, one row per family. Without it the dropdown
  // cannot be opened at all — see `thumbnailSprite`.
  const images = path.join(root, 'sdkjs', 'common', 'Images');
  fs.mkdirSync(images, { recursive: true });
  for (const name of thumbnailSpriteNames()) {
    const scale = Number((name.match(/@([\d.]+)x/) ?? [, '1'])[1]);
    fs.writeFileSync(path.join(images, name), thumbnailSprite({
      width: Math.round(THUMBNAIL_WIDTH * scale),
      rowHeight: Math.round(THUMBNAIL_ROW_HEIGHT * scale),
      count: built.infos.length,
    }));
  }

  const unreadable = files.filter((file) => file.faces.length === 0).map((file) => file.name);
  console.log(`[fonts] ${built.files.length} files, ${built.infos.length} families, ${ranges.length / 3} ranges, ${Math.round(selection.length / 1024)} kB selection, ${thumbnailSpriteNames().length} preview strips -> ${manifest}`);
  if (unreadable.length > 0) console.log(`[fonts] skipped ${unreadable.length}: ${unreadable.join(', ')}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
