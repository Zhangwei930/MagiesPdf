import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canUseOnlineOffice, partitionDocumentPaths } from './office.ts';

describe('partitionDocumentPaths', () => {
  it('routes PDFs to Magies and Office formats to LibreOffice', () => {
    assert.deepEqual(
      partitionDocumentPaths([
        '/docs/report.PDF',
        '/docs/letter.docx',
        '/docs/data.xlsx',
        '/docs/deck.pptx',
        '/docs/script.js',
      ]),
      {
        pdf: ['/docs/report.PDF'],
        office: ['/docs/letter.docx', '/docs/data.xlsx', '/docs/deck.pptx'],
        unsupported: ['/docs/script.js'],
      },
    );
  });

  it('supports LibreOffice-native and legacy Office extensions', () => {
    assert.deepEqual(
      partitionDocumentPaths(['/docs/a.odt', '/docs/b.ods', '/docs/c.odp', '/docs/d.doc']),
      {
        pdf: [],
        office: ['/docs/a.odt', '/docs/b.ods', '/docs/c.odp', '/docs/d.doc'],
        unsupported: [],
      },
    );
  });
});

describe('canUseOnlineOffice', () => {
  it('requires both Collabora and a public WOPI origin', () => {
    assert.equal(
      canUseOnlineOffice({
        libreOffice: { available: true, executable: '/usr/bin/soffice' },
        collabora: { configured: true, serverUrl: 'https://office.example.com' },
        wopiPublicUrl: 'https://files.example.com',
      }),
      true,
    );
    assert.equal(
      canUseOnlineOffice({
        libreOffice: { available: true, executable: '/usr/bin/soffice' },
        collabora: { configured: true, serverUrl: 'https://office.example.com' },
        wopiPublicUrl: '',
      }),
      false,
    );
  });
});
