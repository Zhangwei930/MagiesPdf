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

/** One paragraph becomes one `<w:p>`. Empty strings are kept as blank lines. */
export function paragraphsToDocx(paragraphs: readonly string[]): Uint8Array {
  const body = paragraphs
    .map((paragraph) => {
      if (paragraph === '') return '<w:p/>';
      // Split soft newlines into separate runs with a break, still one paragraph.
      const runs = paragraph.split('\n').map((line, index) => {
        const breakTag = index === 0 ? '' : '<w:br/>';
        return `<w:r>${breakTag}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
      });
      return `<w:p>${runs.join('')}</w:p>`;
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
