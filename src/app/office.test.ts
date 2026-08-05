import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { officeUiThemeFor, partitionDocumentPaths } from './office.ts';

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

describe('officeUiThemeFor', () => {
  it('always uses a white engine skin so text stays readable', () => {
    assert.equal(officeUiThemeFor('system', false), 'theme-white');
    assert.equal(officeUiThemeFor('system', true), 'theme-white');
    assert.equal(officeUiThemeFor('light', false), 'theme-white');
    assert.equal(officeUiThemeFor('dark', true), 'theme-white');
  });
});
