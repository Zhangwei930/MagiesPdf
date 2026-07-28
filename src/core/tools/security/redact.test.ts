import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { allPageText, asInput } from '../../testing/fixtures.ts';
import { parseKeywords, parseRegions, redactTool } from './redact.ts';

async function sensitivePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Secret CONFIDENTIAL code', { x: 50, y: 750, size: 14, font });
  page.drawText('Visible public text', { x: 50, y: 700, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

describe('parseKeywords', () => {
  it('drops blanks and comments', () => {
    assert.deepEqual(parseKeywords('# x\n\nCONFIDENTIAL\nphone\n'), [
      'CONFIDENTIAL',
      'phone',
    ]);
  });
});

describe('security.redact', () => {
  it('removes matching text permanently', async () => {
    const result = await executeTool(redactTool, {
      files: [asInput(await sensitivePdf(), 's.pdf')],
      params: { keywords: 'CONFIDENTIAL' },
    });

    assert.equal(result.files[0]!.name, 's_redacted.pdf');
    const text = allPageText(result.files[0]!.bytes).join(' ');
    assert.ok(!text.includes('CONFIDENTIAL'), text);
    assert.ok(text.includes('Secret'), text);
    assert.ok(text.includes('public'), text);
  });

  it('is case-insensitive by default', async () => {
    const result = await executeTool(redactTool, {
      files: [asInput(await sensitivePdf(), 's.pdf')],
      params: { keywords: 'confidential' },
    });
    const text = allPageText(result.files[0]!.bytes).join(' ');
    assert.ok(!text.includes('CONFIDENTIAL'), text);
  });

  it('errors when nothing matches', async () => {
    await assert.rejects(
      executeTool(redactTool, {
        files: [asInput(await sensitivePdf(), 's.pdf')],
        params: { keywords: 'ZZZ-NOPE' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'EMPTY_RESULT',
    );
  });
});

describe('parseRegions', () => {
  it('reads the region list the viewer sends', () => {
    assert.deepEqual(parseRegions('[{"page":2,"x":10,"y":20,"width":30,"height":40}]'), [
      { page: 2, x: 10, y: 20, width: 30, height: 40 },
    ]);
  });

  it('treats blank text as no regions rather than an error', () => {
    assert.deepEqual(parseRegions(''), []);
    assert.deepEqual(parseRegions('   '), []);
    assert.deepEqual(parseRegions('[]'), []);
  });

  it('rejects malformed JSON', () => {
    assert.throws(() => parseRegions('{not json'), (e: unknown) => e instanceof ToolError);
  });

  it('rejects a region missing a number, rather than silently redacting NaN', () => {
    assert.throws(
      () => parseRegions('[{"page":1,"x":10,"y":20,"width":30}]'),
      (e: unknown) => e instanceof ToolError,
    );
  });

  it('rejects a zero-area region', () => {
    assert.throws(
      () => parseRegions('[{"page":1,"x":10,"y":20,"width":0,"height":40}]'),
      (e: unknown) => e instanceof ToolError,
    );
  });

  it('rejects a page number below 1', () => {
    assert.throws(
      () => parseRegions('[{"page":0,"x":1,"y":2,"width":3,"height":4}]'),
      (e: unknown) => e instanceof ToolError,
    );
  });
});

describe('security.redact — regions', () => {
  it('removes text inside a dragged region and leaves the rest', async () => {
    // "Secret CONFIDENTIAL code" sits at pdf-lib y=750 on an 842-tall page,
    // i.e. ~85pt down from the top in MuPDF's top-left rect space.
    const result = await executeTool(redactTool, {
      files: [asInput(await sensitivePdf(), 's.pdf')],
      params: {
        keywords: '',
        regions: JSON.stringify([{ page: 1, x: 0, y: 60, width: 595, height: 60 }]),
      },
    });

    const text = allPageText(result.files[0]!.bytes).join(' ');
    assert.ok(!text.includes('CONFIDENTIAL'), text);
    assert.ok(!text.includes('Secret'), text);
    assert.ok(text.includes('public'), text);
  });

  it('accepts regions with no keywords at all', async () => {
    await assert.doesNotReject(
      executeTool(redactTool, {
        files: [asInput(await sensitivePdf(), 's.pdf')],
        params: {
          regions: JSON.stringify([{ page: 1, x: 0, y: 60, width: 595, height: 60 }]),
        },
      }),
    );
  });

  it('still errors when neither keywords nor regions are given', async () => {
    await assert.rejects(
      executeTool(redactTool, {
        files: [asInput(await sensitivePdf(), 's.pdf')],
        params: { keywords: '', regions: '' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });

  it('rejects a region pointing past the last page', async () => {
    await assert.rejects(
      executeTool(redactTool, {
        files: [asInput(await sensitivePdf(), 's.pdf')],
        params: {
          regions: JSON.stringify([{ page: 9, x: 0, y: 0, width: 10, height: 10 }]),
        },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });
});
