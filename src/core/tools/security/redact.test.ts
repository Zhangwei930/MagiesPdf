import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { allPageText, asInput } from '../../testing/fixtures.ts';
import { parseKeywords, redactTool } from './redact.ts';

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
