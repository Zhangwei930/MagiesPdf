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

/**
 * A radio group is several widgets sharing one name, and the value names
 * which option to select — not whether a box is ticked.
 *
 * `applyValue` used to run the checkbox path on every widget of the group in
 * turn: `isTruthy('B')` is false, so it turned off whichever button was on and
 * selected nothing. The report was "選 A，填 B 之後還是 A，或者乾脆空了", and
 * that is exactly what the code does.
 */
async function radioPdf(selected = 'A'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const group = doc.getForm().createRadioGroup('gender');
  for (const [index, option] of ['A', 'B', 'C'].entries()) {
    group.addOptionToPage(option, page, { x: 20, y: 200 - index * 30, width: 15, height: 15 });
  }
  group.select(selected);
  return doc.save({ useObjectStreams: false });
}

/** What another reader sees, rather than what the writer thinks it wrote. */
async function selectedOption(bytes: Uint8Array): Promise<string | undefined> {
  const doc = await PDFDocument.load(bytes);
  return doc.getForm().getRadioGroup('gender').getSelected();
}

describe('edit.fill-form and radio groups', () => {
  it('selects the option the value names', async () => {
    const result = await executeTool(fillFormTool, {
      files: [asInput(await radioPdf('A'), 'form.pdf')],
      params: { mode: 'fill', fields: 'gender=B' },
    });

    assert.equal(await selectedOption(result.files[0]!.bytes), 'B');
  });

  it('can move the selection back again', async () => {
    const first = await executeTool(fillFormTool, {
      files: [asInput(await radioPdf('A'), 'form.pdf')],
      params: { mode: 'fill', fields: 'gender=C' },
    });
    const second = await executeTool(fillFormTool, {
      files: [asInput(first.files[0]!.bytes, 'form.pdf')],
      params: { mode: 'fill', fields: 'gender=A' },
    });

    assert.equal(await selectedOption(second.files[0]!.bytes), 'A');
  });

  it('leaves the selection alone when it is already the one asked for', async () => {
    const result = await executeTool(fillFormTool, {
      files: [asInput(await radioPdf('B'), 'form.pdf')],
      params: { mode: 'fill', fields: 'gender=B' },
    });

    assert.equal(await selectedOption(result.files[0]!.bytes), 'B');
  });

  /** Silently selecting nothing is how this went unnoticed. */
  it('says so when the value is not one of the options', async () => {
    const result = await executeTool(fillFormTool, {
      files: [asInput(await radioPdf('A'), 'form.pdf')],
      params: { mode: 'fill', fields: 'gender=Z' },
    });

    assert.match(result.summary?.en ?? '', /not/i);
    assert.equal(await selectedOption(result.files[0]!.bytes), 'A', 'and does not clear it');
  });
});
