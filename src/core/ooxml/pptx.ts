import { zipRead, zipStore } from './zip.ts';
import { escapeXml } from './docx.ts';

/**
 * Minimal PowerPoint Open XML helpers.
 *
 * Reading pulls every `a:t` text run out of each slide (order preserved).
 * Writing builds one title+body slide per string list — enough for PDF→PPT
 * text export, not a layout-preserving converter.
 */

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
};

/** Extract plain text per slide, in slide order. */
export function extractPptxSlideTexts(bytes: Uint8Array): string[] {
  const files = zipRead(bytes);
  const presentation = files.get('ppt/presentation.xml');
  if (!presentation) {
    throw new Error('Not a PPTX package (missing ppt/presentation.xml)');
  }

  const presentationXml = new TextDecoder().decode(presentation);
  // Relationship ids in slide order: <p:sldId r:id="rId2" …/>
  const sldIds = [...presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map(
    (match) => match[1] as string,
  );

  const relsXml = files.get('ppt/_rels/presentation.xml.rels');
  const idToTarget = new Map<string, string>();
  if (relsXml) {
    const text = new TextDecoder().decode(relsXml);
    for (const match of text.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      idToTarget.set(match[1] as string, match[2] as string);
    }
    // Attributes may appear in either order.
    for (const match of text.matchAll(/Target="([^"]+)"[^>]*Id="([^"]+)"/g)) {
      idToTarget.set(match[2] as string, match[1] as string);
    }
  }

  const slidePaths: string[] = [];
  if (sldIds.length > 0) {
    for (const id of sldIds) {
      const target = idToTarget.get(id);
      if (!target) continue;
      const path = target.startsWith('/')
        ? target.slice(1)
        : `ppt/${target.replace(/^\.\//, '')}`;
      slidePaths.push(path);
    }
  } else {
    // Fallback: any slideN.xml in natural order.
    slidePaths.push(
      ...[...files.keys()]
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    );
  }

  return slidePaths.map((path) => {
    const data = files.get(path);
    if (!data) return '';
    return extractTextFromSlideXml(new TextDecoder().decode(data));
  });
}

/** Pull visible text runs from a slide XML part. */
export function extractTextFromSlideXml(xml: string): string {
  const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) =>
    decodeXml(match[1] as string),
  );
  // Collapse whitespace-only runs but keep paragraph-ish gaps via empty runs.
  return runs.join('').replace(/\r\n/g, '\n').trim();
}

function decodeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export interface PptxSlide {
  /** Short title shown at the top of the slide. */
  title: string;
  /** Body paragraphs. */
  body: string[];
}

/** Build a minimal .pptx from slides of plain text. */
export function slidesToPptx(slides: readonly PptxSlide[]): Uint8Array {
  if (slides.length === 0) {
    slides = [{ title: '', body: [''] }];
  }

  const entries: { name: string; data: string }[] = [];

  const contentTypesOverrides = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join('');

  entries.push({
    name: '[Content_Types].xml',
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
      contentTypesOverrides,
      '</Types>',
    ].join(''),
  });

  entries.push({
    name: '_rels/.rels',
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>',
      '</Relationships>',
    ].join(''),
  });

  const sldIdList = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .join('');

  entries.push({
    name: 'ppt/presentation.xml',
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<p:presentation xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">`,
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>',
      `<p:sldIdLst>${sldIdList}</p:sldIdLst>`,
      '<p:sldSz cx="12192000" cy="6858000"/>',
      '<p:notesSz cx="6858000" cy="9144000"/>',
      '</p:presentation>',
    ].join(''),
  });

  const presentationRels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
    ...slides.map(
      (_, i) =>
        `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    ),
  ].join('');

  entries.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRels}</Relationships>`,
    ].join(''),
  });

  // Minimal master + layout so PowerPoint accepts the package.
  entries.push({
    name: 'ppt/slideMasters/slideMaster1.xml',
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<p:sldMaster xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">`,
      '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree>',
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>',
      '</p:spTree></p:cSld>',
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>',
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>',
      '</p:sldMaster>',
    ].join(''),
  });

  entries.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
      '</Relationships>',
    ].join(''),
  });

  entries.push({
    name: 'ppt/slideLayouts/slideLayout1.xml',
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<p:sldLayout xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" type="blank">`,
      '<p:cSld name="Blank"><p:spTree>',
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>',
      '</p:spTree></p:cSld>',
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>',
      '</p:sldLayout>',
    ].join(''),
  });

  entries.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    data: [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>',
      '</Relationships>',
    ].join(''),
  });

  slides.forEach((slide, index) => {
    const n = index + 1;
    entries.push({
      name: `ppt/slides/slide${n}.xml`,
      data: slideXml(slide, n),
    });
    entries.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
        '</Relationships>',
      ].join(''),
    });
  });

  return zipStore(entries);
}

function slideXml(slide: PptxSlide, shapeIdBase: number): string {
  const titleParas = textParagraphs(slide.title || `Slide ${shapeIdBase}`, true);
  const bodyParas =
    slide.body.length > 0
      ? slide.body.map((line) => textParagraphs(line, false)).join('')
      : textParagraphs('', false);

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">`,
    '<p:cSld><p:spTree>',
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>',
    // Title shape
    shape(2, 'Title', 457200, 274638, 11277600, 1143000, titleParas),
    // Body shape
    shape(3, 'Body', 457200, 1600200, 11277600, 4525963, bodyParas),
    '</p:spTree></p:cSld>',
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>',
    '</p:sld>',
  ].join('');
}

function shape(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paragraphs: string,
): string {
  return [
    '<p:sp>',
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`,
    '<p:spPr>',
    `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    '</p:spPr>',
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>${paragraphs}</p:txBody>`,
    '</p:sp>',
  ].join('');
}

function textParagraphs(text: string, title: boolean): string {
  const size = title ? 3200 : 1800; // hundredths of a point
  const lines = text === '' ? [''] : text.split('\n');
  return lines
    .map((line) => {
      const content =
        line === ''
          ? '<a:endParaRPr lang="en-US"/>'
          : `<a:r><a:rPr lang="en-US" sz="${size}" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r>`;
      return `<a:p><a:pPr algn="l"/>${content}</a:p>`;
    })
    .join('');
}
