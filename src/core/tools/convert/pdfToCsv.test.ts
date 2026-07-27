import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { csvCell, pdfToCsvTool, rowsToCsv } from './pdfToCsv.ts';

describe('csvCell / rowsToCsv', () => {
  it('quotes cells that need it', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  });

  it('joins rows with commas and newlines', () => {
    assert.equal(rowsToCsv([['A', 'B'], ['1', '2']]), 'A,B\n1,2\n');
  });
});

describe('convert.pdf-to-csv', () => {
  it('exports page and text columns', async () => {
    const result = await executeTool(pdfToCsvTool, {
      files: [asInput(await samplePdf({ pages: 2, label: (n) => `Row${n}` }), 'r.pdf')],
      params: {},
    });

    assert.equal(result.files[0]!.name, 'r.csv');
    const text = new TextDecoder().decode(result.files[0]!.bytes);
    assert.ok(text.startsWith('Page,Text\n'));
    assert.ok(text.includes('Row1'));
    assert.ok(text.includes('Row2'));
  });

  it('can emit one row per soft line', async () => {
    const result = await executeTool(pdfToCsvTool, {
      files: [asInput(await samplePdf({ pages: 1, label: () => 'Only' }), 'r.pdf')],
      params: { layout: 'line' },
    });
    const text = new TextDecoder().decode(result.files[0]!.bytes);
    assert.ok(text.includes('Only'));
  });
});
