import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { asInput } from '../../testing/fixtures.ts';
import type { ReportRow } from './getInfo.ts';
import { fillFormTool, parseFieldMap } from './fillForm.ts';

async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Name', { x: 50, y: 750, size: 12, font });
  const form = doc.getForm();
  const name = form.createTextField('fullName');
  name.addToPage(page, { x: 100, y: 740, width: 200, height: 20 });
  const note = form.createTextField('note');
  note.addToPage(page, { x: 100, y: 700, width: 200, height: 20 });
  return doc.save({ useObjectStreams: false });
}

describe('parseFieldMap', () => {
  it('parses name=value lines and ignores comments', () => {
    const map = parseFieldMap('# header\nfullName=Alice\nnote=hello=world\n');
    assert.equal(map.get('fullName'), 'Alice');
    assert.equal(map.get('note'), 'hello=world');
  });

  it('rejects a malformed line', () => {
    assert.throws(() => parseFieldMap('noequals'), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'INVALID_PARAM');
      return true;
    });
  });
});

describe('edit.fill-form', () => {
  it('lists field names in report data', async () => {
    const result = await executeTool(fillFormTool, {
      files: [asInput(await formPdf(), 'form.pdf')],
      params: { mode: 'list' },
    });

    const rows = result.data as ReportRow[];
    const names = rows.map((row) => row.label.en);
    assert.ok(names.includes('fullName'));
    assert.ok(names.includes('note'));
  });

  it('fills text fields and persists the values', async () => {
    const result = await executeTool(fillFormTool, {
      files: [asInput(await formPdf(), 'form.pdf')],
      params: {
        mode: 'fill',
        fields: 'fullName=Alice\nnote=Done',
      },
    });

    assert.equal(result.files[0]!.name, 'form_filled.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    try {
      const widgets = doc.loadPage(0).getWidgets();
      const byName = new Map(widgets.map((w) => [w.getName(), String(w.getValue() ?? '')]));
      assert.equal(byName.get('fullName'), 'Alice');
      assert.equal(byName.get('note'), 'Done');
    } finally {
      doc.destroy();
    }
  });

  it('rejects fill with no values', async () => {
    await assert.rejects(
      executeTool(fillFormTool, {
        files: [asInput(await formPdf(), 'form.pdf')],
        params: { mode: 'fill', fields: '' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });
});
