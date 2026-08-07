import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { executeTool } from '../../execute.ts';
import { createFormTool, parseFieldSpecs } from './createForm.ts';

describe('parseFieldSpecs', () => {
  it('reads one field per line, with the page and the box it sits in', () => {
    const specs = parseFieldSpecs('text 姓名 1 72 700 200 24\ncheck 同意 1 72 660 14 14');
    assert.equal(specs.length, 2);
    assert.deepEqual(specs[0], {
      kind: 'text', name: '姓名', page: 1, x: 72, y: 700, width: 200, height: 24, options: [],
    });
    assert.equal(specs[1]!.kind, 'check');
  });

  it('takes a dropdown’s choices after its box', () => {
    const [spec] = parseFieldSpecs('choice 部门 1 72 620 160 24 销售|市场|研发');
    assert.deepEqual(spec!.options, ['销售', '市场', '研发']);
  });

  it('says which line it could not read, rather than dropping it', () => {
    // A field silently missing from a form is discovered by whoever has to
    // fill it in, which is far too late.
    assert.throws(() => parseFieldSpecs('text 姓名 1 72'), /姓名/);
    assert.throws(() => parseFieldSpecs('slider 音量 1 1 1 1 1'), /slider/);
    // How many pages the document has is not something the parser can know;
    // that a page number below 1 is nonsense, it can.
    assert.throws(() => parseFieldSpecs('text 姓名 0 72 700 200 24'), /page/i);
  });

  it('ignores comments and blank lines', () => {
    assert.deepEqual(parseFieldSpecs('# a comment\n\n  \n'), []);
  });
});

describe('edit.create-form', () => {
  it('adds fields another reader can actually fill in', async () => {
    const result = await executeTool(createFormTool, {
      files: [asInput(await samplePdf({ pages: 2 }))],
      params: {
        fields: [
          'text 姓名 1 72 700 200 24',
          'check 同意 1 72 660 14 14',
          'choice 部门 2 72 620 160 24 销售|市场|研发',
        ].join('\n'),
        password: '',
      },
    });

    const doc = await PDFDocument.load(result.files[0]!.bytes);
    const form = doc.getForm();
    assert.deepEqual(form.getFields().map((field) => field.getName()).sort(), ['同意', '姓名', '部门']);
    // The type is what decides whether a reader gets a box to type in or a
    // tick; a form of nothing but text fields is not the form that was asked
    // for, and it looks identical until someone opens it.
    assert.equal(form.getTextField('姓名').constructor.name, 'PDFTextField');
    assert.equal(form.getCheckBox('同意').isChecked(), false);
    assert.deepEqual(form.getDropdown('部门').getOptions(), ['销售', '市场', '研发']);
  });

  it('refuses a field that would land off the page it names', async () => {
    // A widget outside the page is not clipped, it is invisible, and the form
    // comes back with a field nobody can find.
    const input = asInput(await samplePdf({ pages: 1 }));
    await assert.rejects(
      () => executeTool(createFormTool, {
        files: [input],
        params: { fields: 'text 姓名 1 5000 700 200 24', password: '' },
      }),
      /page|outside|超出/i,
    );
  });

  it('refuses a page the document does not have', async () => {
    const input = asInput(await samplePdf({ pages: 2 }));
    await assert.rejects(
      () => executeTool(createFormTool, {
        files: [input],
        params: { fields: 'text 姓名 9 72 700 200 24', password: '' },
      }),
      /9/,
    );
  });

  it('needs at least one field', async () => {
    const input = asInput(await samplePdf());
    await assert.rejects(
      () => executeTool(createFormTool, {
        files: [input],
        params: { fields: '   ', password: '' },
      }),
      /field/i,
    );
  });
});
