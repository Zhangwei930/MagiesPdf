const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { describe, it, before, after } = require('node:test');
const { runUnoOperation } = require('./unoRunner.cjs');
const { officeRuntimeRoot, bundledLibreOfficeExecutable } = require('./libreOffice.cjs');

/**
 * The composing operations, against the real LibreOffice.
 *
 * `automationWiring.test.cjs` matches this worker's source, which proves a line
 * exists and nothing about what it does. Every defect found in the composers so
 * far was of exactly one kind — the code was there and its meaning was inverted
 * or missing — and every one of them walked straight past that suite: a column
 * chart drawn as a bar chart, a chart placed on top of the table it describes,
 * a totals row summing percentages, bulleted paragraphs with no bullets.
 *
 * So this suite asserts against the file that comes out, read as the OOXML that
 * Word and Excel will read, rather than against what the worker says it did.
 * Skipped when the runtime is not vendored, because it is a large download that
 * is deliberately not in git.
 */

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const EXECUTABLE = bundledLibreOfficeExecutable(
  officeRuntimeRoot({ packaged: false, projectRoot: PROJECT_ROOT }),
);
const AVAILABLE = fs.existsSync(EXECUTABLE);

/**
 * One entry out of a zip, inflated.
 *
 * OOXML is a zip and the parts are what the other office suites actually parse,
 * so this is the honest place to look. Reading the central directory rather
 * than scanning for local headers keeps it correct when a name appears twice.
 */
function zipEntry(archive, name) {
  const end = archive.lastIndexOf(0x06054b50 & 0xff);
  let eocd = -1;
  for (let at = archive.length - 22; at >= 0 && at > archive.length - 66000; at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  assert.ok(eocd >= 0 && end >= 0, 'not a zip archive');
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, 'central directory entry');
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const entryName = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (entryName === name) {
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = archive.subarray(start, start + compressedSize);
      return (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return '';
}

function zipNames(archive) {
  const names = [];
  let eocd = -1;
  for (let at = archive.length - 22; at >= 0 && at > archive.length - 66000; at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  const count = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    names.push(archive.toString('utf8', cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describe('the composing operations against the bundled LibreOffice', {
  skip: AVAILABLE ? false : 'vendor/office-runtime is not present',
  timeout: 900000,
}, () => {
  let root = '';
  /** One composed document per kind, produced once. */
  const parts = {
    sheet: null, chart: null, chartRowLabels: null, word: null, slide: null, emptyTable: null, astral: null,
    themedDeck: null, added: null, addedToPlain: null, pivotSource: null, pivot: null,
    pivotWideSource: null, pivotWide: null,
    commented: null, footnoted: null, captioned: null, columned: null, restyled: null,
  };

  /**
   * LibreOffice builds a fresh user profile on every call, which costs seconds
   * and has a fixed connection window. Composing once in `before` and asserting
   * many things afterwards is what keeps this suite honest rather than flaky.
   */
  let composed = 0;
  const compose = async (kind, request, source = null) => {
    const { createBlankOfficeDocument } = await import('../../src/core/office/documents.ts');
    const blank = createBlankOfficeDocument(kind);
    // Unique per call: LibreOffice refuses to store over a file that is already
    // there, so a name derived from the operation collides the second time one
    // is used and the failure looks like the operation's own.
    composed += 1;
    const input = path.join(root, `in-${composed}-${blank.name}`);
    const output = path.join(root, `out-${composed}-${blank.name}`);
    await fsp.writeFile(input, source ?? Buffer.from(blank.bytes));
    await runUnoOperation({
      executable: EXECUTABLE, inputPath: input, outputPath: output, ...request,
    });
    return fsp.readFile(output);
  };

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'magies-uno-'));

    parts.sheet = await compose('sheet', {
      operation: 'excel_compose_table',
      theme: 'azure',
      headers: ['\u6708\u4efd', '\u6536\u5165', '\u6bdb\u5229\u7387'],
      rows: [['1\u6708', 860000, 0.628], ['2\u6708', 1050000, 0.629]],
      columnFormats: ['', '\u00a5#,##0', '0.0%'],
      totalsRow: true,
      totalsLabel: '\u5408\u8ba1',
    });

    parts.chart = await compose('sheet', {
      operation: 'excel_create_chart',
      sheet: 'Sheet1',
      dataRange: 'A1:C3',
      chartType: 'column',
      title: '\u6536\u5165',
    }, parts.sheet);

    // The header row is labels and the first column is not, so which edge the
    // engine actually read is visible in the chart it writes.
    parts.chartRowLabels = await compose('sheet', {
      operation: 'excel_create_chart',
      sheet: 'Sheet1',
      dataRange: 'A1:C3',
      chartType: 'column',
      title: '\u6536\u5165',
      firstRowLabels: true,
      firstColumnLabels: false,
    }, parts.sheet);

    parts.word = await compose('word', {
      operation: 'word_compose',
      theme: 'slate',
      cover: { title: '\u5b63\u5ea6\u56de\u987e', subtitle: '\u589e\u957f', byline: '\u5206\u6790\u7ec4' },
      tableOfContents: true,
      tableOfContentsTitle: '\u76ee\u5f55',
      pageNumbers: true,
      blocks: [
        { style: 'heading1', text: '\u589e\u957f' },
        { style: 'body', text: '\u540c\u6bd4 18%\u3002' },
        { style: 'bullet', text: '\u4f01\u4e1a\u7248\u9700\u6c42\u660e\u786e' },
        { style: 'bullet', text: '\u534e\u4e1c\u8d21\u732e 42%', level: 1 },
        { style: 'number', text: '\u83b7\u5ba2\u6210\u672c\u4e0a\u5347' },
      ],
    });

    parts.emptyTable = await compose('sheet', {
      operation: 'excel_compose_table',
      headers: ['\u6708\u4efd', '\u6536\u5165'],
      rows: [],
      columnFormats: ['', '\u00a5#,##0'],
    });

    parts.astral = await compose('word', {
      operation: 'word_compose',
      cover: { title: '\u5b63\u62a5', byline: '\u5206\u6790\u7ec4 \ud83d\ude80 2026' },
      blocks: [{ style: 'body', text: '\u6b63\u6587' }],
    });

    // Four rows over two regions, so a wrong grouping or a wrong aggregation
    // shows up as a number rather than as a missing table.
    parts.pivotSource = await compose('sheet', {
      operation: 'excel_compose_table',
      headers: ['\u5730\u533a', '\u6536\u5165'],
      rows: [
        ['\u534e\u4e1c', 100], ['\u534e\u5317', 40],
        ['\u534e\u4e1c', 60], ['\u534e\u5317', 5],
      ],
      startCell: 'A1',
    });

    parts.pivot = await compose('sheet', {
      operation: 'excel_create_pivot',
      sourceSheet: 'Sheet1',
      sourceRange: 'A1:B5',
      rowFields: ['\u5730\u533a'],
      columnFields: [],
      filterFields: [],
      dataFields: [{ field: '\u6536\u5165', function: 'SUM' }],
      destinationSheet: 'Pivot',
      destinationCell: 'A1',
      pivotName: 'MagiesPivot',
      grandTotalLabel: '\u603b\u8ba1',
    }, parts.pivotSource);

    // Five columns, so every field area has something to hold: a page field, a
    // column field, two measures, and a row field with one region ranked out.
    // 17 and 127 are \u534e\u4e2d's totals and must not survive topN: 2.
    parts.pivotWideSource = await compose('sheet', {
      operation: 'excel_compose_table',
      headers: ['\u5730\u533a', '\u5b63\u5ea6', '\u5e74\u4efd', '\u6536\u5165', '\u8ba2\u5355'],
      rows: [
        ['\u534e\u4e1c', 'Q1', 2025, 100, 31],
        ['\u534e\u5317', 'Q1', 2025, 40, 21],
        ['\u534e\u4e2d', 'Q1', 2025, 8, 63],
        ['\u534e\u4e1c', 'Q2', 2025, 60, 41],
        ['\u534e\u5317', 'Q2', 2025, 5, 22],
        ['\u534e\u4e2d', 'Q2', 2025, 9, 64],
      ],
      startCell: 'A1',
    });

    parts.pivotWide = await compose('sheet', {
      operation: 'excel_create_pivot',
      sourceSheet: 'Sheet1',
      sourceRange: 'A1:E7',
      rowFields: ['\u5730\u533a'],
      columnFields: ['\u5b63\u5ea6'],
      filterFields: ['\u5e74\u4efd'],
      dataFields: [
        { field: '\u6536\u5165', function: 'SUM', label: '\u6536\u5165\u5408\u8ba1' },
        { field: '\u8ba2\u5355', function: 'SUM', label: '\u8ba2\u5355\u6570' },
      ],
      sortByData: 'descending',
      topN: 2,
      numberFormat: '\u00a5#,##0',
      optimalWidth: true,
      chartType: 'column',
      chartTitle: '\u5730\u533a\u6536\u5165',
      destinationSheet: 'Pivot',
      destinationCell: 'A1',
      pivotName: 'MagiesPivot',
      grandTotalLabel: '\u603b\u8ba1',
    }, parts.pivotWideSource);

    parts.columned = await compose('word', {
      operation: 'word_compose',
      columns: 2,
      columnGapMm: 8,
      columnRule: true,
      blocks: [{ style: 'body', text: '\u4e24\u680f\u6392\u7248\u7684\u6b63\u6587\u3002' }],
    });

    const figure = path.join(root, 'figure.png');
    // A 1x1 PNG is enough: what is being tested is the caption, not the picture.
    await fsp.writeFile(figure, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));
    parts.captioned = await compose('word', {
      operation: 'word_insert_image',
      imagePath: figure,
      widthMm: 40,
      caption: '\u5b63\u5ea6\u6536\u5165\u8d8b\u52bf',
      captionLabel: '\u56fe',
    }, parts.word);

    parts.footnoted = await compose('word', {
      operation: 'word_add_footnotes',
      footnotes: [
        { find: '18%', text: '\u4e0d\u542b\u6c47\u5151\u5f71\u54cd\u3002' },
        { find: '\u589e\u957f', text: '\u53e3\u5f84\u89c1\u9644\u5f55\u4e00\u3002', kind: 'endnote' },
      ],
    }, parts.word);

    parts.commented = await compose('sheet', {
      operation: 'excel_add_comments',
      sheet: 'Sheet1',
      comments: [
        { cell: 'A1', text: '\u8fd9\u4e2a\u6570\u5b57\u5f85\u6838' },
        { cell: 'B2', text: '\u6765\u6e90\uff1a\u8d22\u52a1' },
        // The same cell twice: a cell holds one note, not a stack of them.
        { cell: 'A1', text: '\u6539\u8fc7\u7684\u6279\u6ce8' },
      ],
    }, parts.pivotSource);

    parts.themedDeck = await compose('slide', {
      operation: 'presentation_compose',
      theme: 'forest',
      footer: '2026 Q3',
      replaceExisting: true,
      slides: [{ layout: 'title', title: '季度回顾' }],
    });

    // A deck somebody else made: no Magies background on any slide, so the
    // master is the only place a new look can come from.
    parts.restyled = await compose('slide', {
      operation: 'presentation_apply_theme',
      theme: 'midnight',
      footer: '\u5185\u90e8\u8d44\u6599',
    });

    parts.added = await compose('slide', {
      operation: 'presentation_add_slide',
      title: '补一页',
      body: ['第一条', '第二条'],
    }, parts.themedDeck);

    // A deck Magies never composed must not be restyled by adding to it.
    parts.addedToPlain = await compose('slide', {
      operation: 'presentation_add_slide',
      title: '补一页',
      body: ['第一条'],
    });

    parts.slide = await compose('slide', {
      operation: 'presentation_compose',
      theme: 'azure',
      replaceExisting: true,
      slides: [
        { layout: 'bullets', title: '\u673a\u4f1a', body: ['\u9700\u6c42\u660e\u786e', '\u6e20\u9053\u53ef\u590d\u5236'] },
        { layout: 'image', title: '\u4ea7\u54c1\u7ebf', body: ['\u8fdb\u5165\u4f01\u4e1a\u7248'] },
      ],
    });
  });

  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('writes a column chart as columns', () => {
    const name = zipNames(parts.chart).find((entry) => /^xl\/charts\/chart\d+\.xml$/.test(entry));
    assert.ok(name, 'the workbook carries a chart part');
    // The whole bug: BarDiagram.Vertical means the bars run horizontally, so a
    // column chart is Vertical=False. Inverted, every column chart came out as
    // a bar chart and the return value still said it had worked.
    assert.match(zipEntry(parts.chart, name), /<c:barDir val="col"\/>/);
  });

  it('reads labels off the edge the caller named, not the other one', () => {
    // The engine takes two flags in its own order — the topmost row, then the
    // leftmost column — and they were handed over the other way round. Both
    // default to true, so it only showed when a caller turned one off: asking
    // for the header row to be labels labelled the first column instead, and
    // the header row was plotted as data.
    const name = zipNames(parts.chartRowLabels)
      .find((entry) => /^xl\/charts\/chart\d+\.xml$/.test(entry));
    assert.ok(name, 'the workbook carries a chart part');
    const chart = zipEntry(parts.chartRowLabels, name);
    const series = [...chart.matchAll(/<c:tx>[\s\S]*?<c:f>(.*?)<\/c:f>/g)].map((match) => match[1]);
    const categories = [...chart.matchAll(/<c:cat>[\s\S]*?<c:f>(.*?)<\/c:f>/g)].map((match) => match[1]);
    // Row 1 holds 月份/收入/成本, so with firstRowLabels the series are named
    // from row 1 — every reference to a single cell in it.
    assert.ok(series.length > 0, `no series names: ${chart.slice(0, 200)}`);
    for (const reference of series) {
      assert.match(reference, /\$[A-C]\$1$/, `series named off row ${reference}, not row 1`);
    }
    for (const reference of categories) {
      assert.doesNotMatch(reference, /\$A\$/, `column A was labelled despite firstColumnLabels: false`);
    }
  });

  it('anchors the chart beside the table rather than over it', () => {
    const drawing = zipEntry(parts.chart, 'xl/drawings/drawing1.xml');
    const column = Number(/<xdr:from>\s*<xdr:col>(\d+)<\/xdr:col>/.exec(drawing)?.[1] ?? -1);
    // Past the data's last column (C is index 2), not the fixed top-left corner
    // that used to drop every chart on top of the table it describes.
    assert.ok(column > 2, `chart anchored at column ${column}, which is over the data`);
  });

  it('leaves a ratio column out of the totals row', () => {
    const sheet = zipEntry(parts.sheet, 'xl/worksheets/sheet1.xml');
    const totals = /<row[^>]*r="4"[^>]*>(.*?)<\/row>/s.exec(sheet)?.[1] ?? '';
    assert.match(totals, /r="B4"/, 'the money column is totalled');
    // 62.8% + 62.9% is not 125.7% of anything, and an indefensible number in a
    // client's spreadsheet is worse than an empty cell.
    assert.doesNotMatch(totals, /r="C4"[^/]*>\s*<(f|v)>/, 'the ratio column is left empty');
  });

  it('gives bulleted and numbered paragraphs their markers', () => {
    const document = zipEntry(parts.word, 'word/document.xml');
    // A document built from nothing carries no List Bullet style at all, so
    // these paragraphs used to come out as Normal: a list rendered as prose,
    // with the markers the author wrote silently gone.
    assert.match(document, /w:pStyle w:val="ListBullet"/);
    assert.match(document, /w:pStyle w:val="ListNumber"/);
    assert.match(document, /<w:numPr>/);
  });

  it('builds the cover, the contents page and the page number a report needs', () => {
    const document = zipEntry(parts.word, 'word/document.xml');
    assert.match(document, /w:pStyle w:val="Title"/);
    // The contents page is a field, not typed-out text. Typed text is the
    // failure this tool exists to prevent.
    assert.match(document, /TOC \\/);
    const footer = zipNames(parts.word).find((entry) => /^word\/footer\d+\.xml$/.test(entry));
    assert.ok(footer, 'a footer part exists');
    assert.match(zipEntry(parts.word, footer), /PAGE/);
  });

  it('draws a figure on an image slide that has no picture', () => {
    const slide = zipEntry(parts.slide, 'ppt/slides/slide2.xml');
    // No picture provider is configured on most installations. The visual half
    // of the slide is drawn from the theme; without it the layout collapses
    // into one more bullet list and the deck reads as generated.
    const shapes = (slide.match(/<p:sp>/g) || []).length;
    assert.ok(shapes > 8, `image slide drew only ${shapes} shapes, so no figure was composed`);
    assert.doesNotMatch(slide, /<p:pic>/, 'nothing claims to be a picture');
  });

  it('draws nothing below the header when a table has no rows', () => {
    const sheet = zipEntry(parts.emptyTable, 'xl/worksheets/sheet1.xml');
    // The body used to claim one row whatever happened, so an empty table came
    // out with a bordered, right-aligned, currency-formatted phantom row.
    assert.doesNotMatch(sheet, /<row[^>]*r="2"/, 'a row exists below the header');
  });

  it('formats a byline that reaches outside the basic plane without losing its end', () => {
    const document = zipEntry(parts.astral, 'word/document.xml');
    // The cursor moves in UTF-16 units. Counting code points left the last unit
    // of an astral character outside the selection, so the run split in two and
    // the tail kept the paragraph's colour instead of the byline's.
    const byline = /<w:p\b[^>]*>(?:(?!<\/w:p>).)*?2026(?:(?!<\/w:p>).)*?<\/w:p>/s.exec(document);
    assert.ok(byline, 'the byline paragraph is in the document');
    // An emoji lands in a run of its own whatever happens, because its font
    // differs. What matters is that every run carries the 10.5pt the byline
    // was formatted at: a selection that stopped short would leave the tail
    // at the paragraph style's size.
    const runs = byline[0].match(/<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>/gs) || [];
    assert.ok(runs.length > 0, 'the byline has formatted runs');
    assert.ok(
      runs.every((run) => /w:sz w:val="21"/.test(run)),
      `a run kept the paragraph size instead of the byline's: ${runs.join(' | ').slice(0, 300)}`,
    );
  });

  it('keeps a nested outline nested in the document', () => {
    const document = zipEntry(parts.word, 'word/document.xml');
    // A sub-point written one level in has to come out one level in. Flattened,
    // it reads as a peer of the point it belongs to, which inverts the outline
    // the author wrote.
    assert.match(document, /<w:ilvl w:val="1"\/>/);
    // And the outer items stay outer rather than everything sliding in.
    assert.match(document, /<w:ilvl w:val="0"\/>/);
  });

  it('leaves one note per cell, whatever it was asked twice', () => {
    const names = zipNames(parts.commented);
    const comments = names.find((name) => /^xl\/comments\d+\.xml$/.test(name));
    assert.ok(comments, 'the workbook carries a comments part');
    const body = zipEntry(parts.commented, comments);
    assert.match(body, /\u6765\u6e90\uff1a\u8d22\u52a1/);
    // Setting a comment on a cell replaces it. Inserting beside the old one
    // leaves two boxes stacked on the same cell, which is unreadable and is not
    // what "add a comment here" means.
    assert.match(body, /\u6539\u8fc7\u7684\u6279\u6ce8/);
    assert.doesNotMatch(body, /\u8fd9\u4e2a\u6570\u5b57\u5f85\u6838/);
  });

  it('anchors footnotes and endnotes to the words they belong to', () => {
    const names = zipNames(parts.footnoted);
    assert.ok(names.includes('word/footnotes.xml'), 'a footnotes part exists');
    assert.ok(names.includes('word/endnotes.xml'), 'an endnotes part exists');
    // The note text lives in its own part; what makes it a footnote rather than
    // a sentence in brackets is the reference left in the body.
    assert.match(zipEntry(parts.footnoted, 'word/footnotes.xml'), /\u4e0d\u542b\u6c47\u5151\u5f71\u54cd/);
    assert.match(zipEntry(parts.footnoted, 'word/endnotes.xml'), /\u53e3\u5f84\u89c1\u9644\u5f55\u4e00/);
    const document = zipEntry(parts.footnoted, 'word/document.xml');
    assert.match(document, /<w:footnoteReference/);
    assert.match(document, /<w:endnoteReference/);
  });

  it('numbers a figure caption with a field rather than a typed digit', () => {
    const document = zipEntry(parts.captioned, 'word/document.xml');
    assert.match(document, /\u5b63\u5ea6\u6536\u5165\u8d8b\u52bf/, 'the caption text is there');
    // A typed "图 1" does not renumber when a figure is inserted above it, and
    // a document where the figures and their numbers disagree is worse than one
    // with no captions. The number has to be a SEQ field.
    // The label the reader sees is Chinese; the counter behind it cannot be.
    // A non-ASCII sequence name silently evaluates to nothing, and the caption
    // comes out with an empty gap where its number belongs — worse than no
    // caption, because the document still looks finished.
    assert.match(document, /SEQ Figure/, 'the counter is a field');
    assert.match(document, /w:pStyle w:val="Caption"/, 'and it carries the caption style');

    // What the reader actually sees. A field exports with whatever result it
    // last computed, and one never computed exports empty — Word would show
    // "图  季度收入趋势" until somebody pressed F9.
    const paragraph = /<w:p\b(?:(?!<\/w:p>).)*Caption(?:(?!<\/w:p>).)*<\/w:p>/s.exec(document);
    assert.ok(paragraph, 'the caption paragraph is in the document');
    // The field code is text in the XML but not on the page.
    const shown = paragraph[0]
      .replace(/<w:instrText[^>]*>.*?<\/w:instrText>/gs, '')
      .replace(/<[^>]+>/g, '');
    assert.equal(shown, '\u56fe 1 \u5b63\u5ea6\u6536\u5165\u8d8b\u52bf');
  });

  it('sets columns on the page rather than faking them with a table', () => {
    const document = zipEntry(parts.columned, 'word/document.xml');
    // Columns belong to the section. A two-column table would look the same on
    // page one and then refuse to flow, so the text stops at the bottom of the
    // first cell instead of continuing in the next column.
    assert.match(document, /<w:cols[^>]*w:num="2"/);
    assert.match(document, /<w:cols[^>]*w:sep="true"/, 'the rule between them');
  });

  it('restyles an existing deck through its master, not slide by slide', () => {
    const names = zipNames(parts.restyled);
    const master = names.find((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name));
    assert.ok(master, 'the deck has a master');
    // Painting each slide would leave anything added afterwards — by us or by
    // PowerPoint — on the old white background. The master is what a deck
    // inherits from, so it is where a new look belongs.
    assert.match(zipEntry(parts.restyled, master), /<p:bg>/);
    // And the theme is remembered, so a slide added later still joins.
    assert.match(zipEntry(parts.restyled, 'docProps/custom.xml'), /midnight/);
  });

  it('gives a slide added later the look of the deck it joins', () => {
    // A deck is composed once and then edited. Without this the added slide is
    // a white page with 26pt text in the middle of a themed deck — the "half
    // designed" result composing exists to avoid, reintroduced by the very next
    // call the user makes.
    assert.match(zipEntry(parts.themedDeck, 'docProps/custom.xml'), /MagiesTheme/);
    assert.match(zipEntry(parts.themedDeck, 'docProps/custom.xml'), /forest/);

    const added = zipEntry(parts.added, 'ppt/slides/slide2.xml');
    assert.ok(added, 'the slide was added');
    assert.match(added, /<p:bg>/, 'the added slide carries the deck background');

    // Someone else's deck keeps its own look: applying our theme to one slide
    // of a corporate template would be worse than the plain slide.
    const plain = zipEntry(parts.addedToPlain, 'ppt/slides/slide2.xml');
    assert.doesNotMatch(plain, /<p:bg>/, 'an unthemed deck was restyled');
  });

  it('aggregates a pivot table over the field it was given', () => {
    // The only operation complex enough to be worth doubting that had never
    // once been executed. A pivot that builds but groups by the wrong field, or
    // counts where it was asked to sum, returns exactly the same success shape.
    const names = zipNames(parts.pivot);
    const pivotSheet = names.find((name) => /^xl\/worksheets\/sheet2\.xml$/.test(name));
    assert.ok(pivotSheet, 'the destination worksheet exists');
    const sheet = zipEntry(parts.pivot, pivotSheet);
    const numbers = [...sheet.matchAll(/<v>([\d.]+)<\/v>/g)].map((match) => Number(match[1]));
    // 100 + 60 and 40 + 5, and the grand total. Anything else means it grouped
    // or aggregated by something other than what was asked for.
    assert.ok(numbers.includes(160), `no 160 in the pivot: ${numbers.join(', ')}`);
    assert.ok(numbers.includes(45), `no 45 in the pivot: ${numbers.join(', ')}`);
    assert.ok(numbers.includes(205), `no grand total in the pivot: ${numbers.join(', ')}`);

    // The engine writes its own furniture in English. A Chinese quarterly report
    // with "Total Result" down the middle is the same tell as a deck of bullet
    // lists: the document reads as generated by something that was not paying
    // attention. The stray "Filter" cell is a page-area button with no page
    // fields behind it, so it says nothing at all.
    const labels = zipEntry(parts.pivot, 'xl/sharedStrings.xml');
    assert.match(labels, /\u603b\u8ba1/, 'the grand total keeps the name it was given');
    assert.doesNotMatch(labels, /Total Result/);
    assert.doesNotMatch(labels, /<t[^>]*>Filter</);
  });

  it('ranks, formats, and charts a pivot with every field area filled', () => {
    const names = zipNames(parts.pivotWide);
    const pivotSheet = names.find((name) => /^xl\/worksheets\/sheet2\.xml$/.test(name));
    assert.ok(pivotSheet, 'the destination worksheet exists');
    const sheet = zipEntry(parts.pivotWide, pivotSheet);
    // Only the numeric cells. A cell holding a string carries its index into
    // sharedStrings in the same <v>, so matching every <v> reads label indices
    // as if they were aggregates.
    const numbers = [...sheet.matchAll(/<c [^>]*r="[A-Z]+\d+"([^>]*)>\s*<v>([^<]*)<\/v>/g)]
      .filter((match) => !/t="s"/.test(match[1]))
      .map((match) => Number(match[2]));
    assert.ok(numbers.includes(160), `no 华东 total: ${numbers.join(', ')}`);
    assert.ok(numbers.includes(45), `no 华北 total: ${numbers.join(', ')}`);
    assert.ok(numbers.includes(72), `no second measure: ${numbers.join(', ')}`);
    // topN keeps the two largest by the first measure, and the grand total then
    // covers only what is shown. 华中 totals 17 and 127 must be gone.
    assert.ok(!numbers.includes(17), `华中 survived topN: ${numbers.join(', ')}`);
    assert.ok(!numbers.includes(127), `华中 survived topN: ${numbers.join(', ')}`);
    assert.ok(numbers.includes(205), `no ranked grand total: ${numbers.join(', ')}`);

    const labels = zipEntry(parts.pivotWide, 'xl/sharedStrings.xml');
    // The page field is the one that reaches the reader as a control rather
    // than as a column, so its name has to be on the sheet.
    assert.match(labels, /年份/, 'the page field is not in the output');
    // And the measures are called what they were named, not "Sum - 收入".
    assert.match(labels, /收入合计/, 'the measure kept the engine\'s own header');
    assert.doesNotMatch(labels, /Sum - /);

    assert.match(
      zipEntry(parts.pivotWide, 'xl/styles.xml'),
      /¥#,##0/,
      'the number format never reached the pivot body',
    );
    // The ranking has to be in the pivot's own definition, not only in the
    // cells the engine happened to write. Without it the first refresh brings
    // the ranked-out rows back, and the file stops agreeing with what the
    // operation reported — 华中 reappearing in a report that says top two.
    const definition = zipEntry(parts.pivotWide, 'xl/pivotTables/pivotTable1.xml');
    // On the ranked field itself. `<pivotFields>` is the container and wears
    // the same prefix, so matching the attributes anywhere in the part passes
    // for a definition that ranks nothing.
    const ranked = [...definition.matchAll(/<pivotField(?=[ />])[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('autoShow'));
    assert.equal(ranked.length, 1, `ranking landed on ${ranked.length} fields: ${definition.slice(0, 400)}`);
    assert.match(ranked[0], /axis="axisRow"/, 'the ranking landed on a field that is not a row field');
    assert.match(ranked[0], /autoShow="1" topAutoShow="1"/);
    assert.match(ranked[0], /itemPageCount="2"/, 'the ranking kept the wrong count');
    const chart = names.find((name) => /^xl\/charts\/chart\d+\.xml$/.test(name));
    assert.ok(chart, `no pivot chart was drawn: ${names.join(', ')}`);
    // Rows 1-3 are the page field and the column-field label; 9 and 10 are the
    // two grand totals. Charting either is visibly wrong, so the plotted refs
    // are the assertion rather than the mere existence of a chart.
    const plotted = [...zipEntry(parts.pivotWide, chart).matchAll(/<c:f>(.*?)<\/c:f>/g)]
      .map((match) => match[1]);
    assert.ok(plotted.length > 0, 'the chart plots nothing');
    for (const reference of plotted) {
      assert.match(reference, /^Pivot!\$[A-D]\$([4-8])(:\$[A-D]\$[4-8])?$/, `charted outside the pivot body: ${reference}`);
    }
  });

  it('keeps composed slide text inside the band the layout gave it', () => {
    const slide = zipEntry(parts.slide, 'ppt/slides/slide1.xml');
    // Formatting the text makes the engine re-lay-out the shape, and with a
    // vertical adjustment set it re-anchors: the body walked up out of its band
    // and into the heading rule until the geometry was pinned afterwards.
    const tops = [...slide.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/g)]
      .map((match) => Number(match[2]));
    assert.ok(tops.length > 0, 'shapes carry explicit offsets');
    assert.ok(Math.min(...tops) >= 0, `a shape sits above the slide at y=${Math.min(...tops)}`);
  });
});
