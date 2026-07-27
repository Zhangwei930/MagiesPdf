import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import type { ReportRow } from '../edit/getInfo.ts';
import { inspectSignaturesTool } from './inspectSignatures.ts';

describe('security.inspect-signatures', () => {
  it('reports zero on a plain PDF', async () => {
    const result = await executeTool(inspectSignaturesTool, {
      files: [asInput(await samplePdf({ pages: 1 }), 'plain.pdf')],
      params: {},
    });
    const rows = result.data as ReportRow[];
    const count = rows.find((row) => row.label.en === 'Signature fields');
    assert.equal(count?.value, '0');
  });

  it('counts non-signature widgets separately', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    const field = form.createTextField('notes');
    field.addToPage(page, { x: 20, y: 200, width: 120, height: 18 });
    await doc.embedFont(StandardFonts.Helvetica);
    const bytes = await doc.save({ useObjectStreams: false });

    const result = await executeTool(inspectSignaturesTool, {
      files: [asInput(bytes, 'form.pdf')],
      params: {},
    });
    const rows = result.data as ReportRow[];
    assert.equal(rows.find((r) => r.label.en === 'Signature fields')?.value, '0');
    assert.equal(rows.find((r) => r.label.en === 'Other form widgets')?.value, '1');
  });
});
