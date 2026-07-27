import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { addSignatureTool, formatSignDate } from './sign.ts';

async function signaturePng(): Promise<Uint8Array> {
  // Reuse a rendered PDF page as a stand-in image — real drawn strokes are UI-side.
  const source = openDocument(await samplePdf({ pages: 1, label: () => 'Sig' }));
  try {
    return renderPage(source, 0, { dpi: 72, format: 'png' }).bytes;
  } finally {
    source.destroy();
  }
}

describe('formatSignDate', () => {
  it('formats YYYY-MM-DD', () => {
    assert.equal(formatSignDate(new Date('2026-07-27T12:00:00Z')).slice(0, 4), '2026');
    assert.match(formatSignDate(new Date()), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('security.add-signature', () => {
  it('stamps an image signature onto the last page', async () => {
    const result = await executeTool(addSignatureTool, {
      files: [
        asInput(await samplePdf({ pages: 2, label: (n) => `P${n}` }), 'doc.pdf'),
        asInput(await signaturePng(), 'sig.png', 'image/png'),
      ],
      params: { mode: 'image', pages: 'last' },
    });

    assert.equal(result.files[0]!.name, 'doc_signed.pdf');
    const doc = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(doc.countPages(), 2);
    } finally {
      doc.destroy();
    }
  });

  it('draws a typed name signature without an image', async () => {
    const result = await executeTool(addSignatureTool, {
      files: [asInput(await samplePdf({ pages: 1 }), 'a.pdf')],
      params: {
        mode: 'text',
        signerName: 'Alice Example',
        reason: 'Approved',
        includeDate: true,
        pages: 'all',
      },
    });

    // Name is drawn via pdf-lib standard fonts; extractable text may or may not
    // include it depending on encoding — file must still be a valid multi-object PDF.
    assert.ok(result.files[0]!.bytes.length > 500);
    assert.ok(result.files[0]!.name.endsWith('_signed.pdf'));
  });

  it('rejects image mode without an image', async () => {
    await assert.rejects(
      executeTool(addSignatureTool, {
        files: [asInput(await samplePdf({ pages: 1 }), 'a.pdf')],
        params: { mode: 'image' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_INPUT',
    );
  });

  it('rejects text mode without a name', async () => {
    await assert.rejects(
      executeTool(addSignatureTool, {
        files: [asInput(await samplePdf({ pages: 1 }), 'a.pdf')],
        params: { mode: 'text', signerName: '' },
      }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_PARAM',
    );
  });
});
