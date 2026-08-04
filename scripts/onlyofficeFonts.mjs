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

/** The manifest as the file the engine loads. */
export function manifestSource({ files, infos }, ranges = []) {
  const rows = infos.map((row) => JSON.stringify(row)).join(',\n');
  return `// Generated by scripts/onlyofficeFonts.mjs from the fonts that ship
// with the engine. Do not edit; regenerate with \`npm run fonts:engine\`.
window["__all_fonts_js_version__"] = 2;

window["__fonts_files"] = ${JSON.stringify(files, null, 0)};

window["__fonts_infos"] = [
${rows}
];

// The font selection table, which the engine skips when it is empty. It has to
// be declared: the engine's check is \`!= ""\`, which undefined passes, so
// leaving it out makes the engine decode a table that is not there and die
// before it loads a font. Generating a real one is allfontsgen's other
// output; without it the engine falls back on its built-in language defaults.
window["g_fonts_selection_bin"] = "";

// Which family to fall back on for a character the document's font cannot
// draw. Without it a document in a font that is not here renders as boxes.
window["__fonts_ranges"] = ${JSON.stringify(ranges)};
`;
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
  const root = process.argv[2] ?? 'vendor/onlyoffice/mac-x64/web';
  const fonts = path.join(root, 'fonts');
  const manifest = path.join(root, 'sdkjs', 'common', 'AllFonts.js');

  const files = readFontDirectory(fonts);
  const built = buildManifest(files);
  const coverage = new Map(built.files.map((name) => [
    name,
    readCoverage(fs.readFileSync(path.join(fonts, name))),
  ]));
  const ranges = buildRanges(built, files, coverage);
  fs.writeFileSync(manifest, manifestSource(built, ranges));

  const unreadable = files.filter((file) => file.faces.length === 0).map((file) => file.name);
  console.log(`[fonts] ${built.files.length} files, ${built.infos.length} families, ${ranges.length / 3} ranges -> ${manifest}`);
  if (unreadable.length > 0) console.log(`[fonts] skipped ${unreadable.length}: ${unreadable.join(', ')}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
