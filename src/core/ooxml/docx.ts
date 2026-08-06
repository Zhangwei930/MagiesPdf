import { zipStore } from './zip.ts';

/**
 * Build a minimal .docx from plain paragraphs.
 *
 * Layout fidelity is not the goal — this is the reverse of "PDF → Word" for
 * text extraction workflows (edit in Word, re-import). Tables, images and
 * precise positions are intentionally out of scope.
 */

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface DocxTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  size?: number;
}

export interface DocxParagraphSpec {
  text?: string;
  runs?: DocxTextRun[];
  bold?: boolean;
  size?: number;
  isPageBreak?: boolean;
  spacingAfter?: number;
}

/** One paragraph becomes one `<w:p>`. Empty strings are kept as blank lines. */
export function paragraphsToDocx(
  paragraphs: readonly (string | DocxParagraphSpec)[],
): Uint8Array {
  const body = paragraphs
    .map((p) => {
      if (typeof p === 'string') {
        if (p === '') return '<w:p/>';
        // Split soft newlines into separate runs with a break, still one paragraph.
        const runs = p.split('\n').map((line, index) => {
          const breakTag = index === 0 ? '' : '<w:br/>';
          return `<w:r>${breakTag}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
        });
        return `<w:p>${runs.join('')}</w:p>`;
      }

      if (p.isPageBreak) {
        return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      }

      const runs: string[] = [];
      if (p.runs && p.runs.length > 0) {
        for (const run of p.runs) {
          const bTag = run.bold ? '<w:b/>' : '';
          const iTag = run.italic ? '<w:i/>' : '';
          const szTag = run.size
            ? `<w:sz w:val="${Math.round(run.size * 2)}"/><w:szCs w:val="${Math.round(run.size * 2)}"/>`
            : '';
          const rPr = bTag || iTag || szTag ? `<w:rPr>${bTag}${iTag}${szTag}</w:rPr>` : '';
          runs.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`);
        }
      } else if (p.text) {
        const szVal = Math.round((p.size || 11) * 2);
        const bTag = p.bold ? '<w:b/>' : '';
        const rPr = `<w:rPr>${bTag}<w:sz w:val="${szVal}"/><w:szCs w:val="${szVal}"/></w:rPr>`;
        runs.push(`<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r>`);
      }

      const spaceAfter = p.spacingAfter ?? (p.size && p.size > 14 ? 160 : 60);
      const pPr = `<w:pPr><w:spacing w:after="${spaceAfter}"/></w:pPr>`;
      return `<w:p>${pPr}${runs.join('')}</w:p>`;
    })
    .join('');

  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body>${body}<w:sectPr/></w:body>`,
    '</w:document>',
  ].join('');

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join('');

  const rels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join('');

  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
  ]);
}
