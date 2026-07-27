import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { allPageText, asInput, encryptPdf, samplePdf } from '../../testing/fixtures.ts';
import { imageToPdfTool, sniffImage } from './imageToPdf.ts';
import { pdfToImageTool } from './pdfToImage.ts';
import { pdfToMarkdownTool, pdfToTextTool } from './extractText.ts';

const doc = async (pages: number, name = 'report.pdf') =>
  asInput(await samplePdf({ pages, label: (n) => `P${n}` }), name);

/** Renders a page of a sample PDF to real image bytes for image-input tests. */
async function sampleImage(format: 'png' | 'jpeg'): Promise<Uint8Array> {
  const source = openDocument(await samplePdf({ pages: 1 }));
  try {
    return renderPage(source, 0, { dpi: 72, format }).bytes;
  } finally {
    source.destroy();
  }
}

describe('convert.pdf-to-image', () => {
  it('renders one PNG per page with PNG magic bytes', async () => {
    const result = await executeTool(pdfToImageTool, { files: [await doc(3)], params: {} });

    assert.equal(result.files.length, 3);
    assert.deepEqual(result.files.map((f) => f.name), [
      'report_1.png',
      'report_2.png',
      'report_3.png',
    ]);
    for (const file of result.files) {
      assert.deepEqual([...file.bytes.slice(1, 4)], [0x50, 0x4e, 0x47], `${file.name} not a PNG`);
      assert.equal(file.mime, 'image/png');
    }
  });

  it('renders JPEG when asked', async () => {
    const result = await executeTool(pdfToImageTool, {
      files: [await doc(1)],
      params: { format: 'jpeg', quality: 70 },
    });

    assert.equal(result.files[0]!.name, 'report_1.jpg');
    assert.deepEqual([...result.files[0]!.bytes.slice(0, 3)], [0xff, 0xd8, 0xff]);
  });

  it('respects the page selection', async () => {
    const result = await executeTool(pdfToImageTool, {
      files: [await doc(5)],
      params: { pages: '2,4' },
    });
    assert.deepEqual(result.files.map((f) => f.name), ['report_2.png', 'report_4.png']);
  });

  it('scales pixel dimensions with DPI', async () => {
    const at72 = await executeTool(pdfToImageTool, {
      files: [await doc(1)],
      params: { dpi: 72 },
    });
    const at144 = await executeTool(pdfToImageTool, {
      files: [await doc(1)],
      params: { dpi: 144 },
    });
    // Higher DPI ⇒ more pixels ⇒ more bytes; a loose but engine-independent check.
    assert.ok(at144.files[0]!.bytes.length > at72.files[0]!.bytes.length);
  });

  it('renders an encrypted document with its password', async () => {
    const locked = asInput(encryptPdf(await samplePdf({ pages: 1 }), { userPassword: 'pw' }), 'l.pdf');
    const result = await executeTool(pdfToImageTool, {
      files: [locked],
      params: { password: 'pw' },
    });
    assert.equal(result.files.length, 1);
  });
});

describe('sniffImage', () => {
  it('detects PNG and JPEG by magic bytes', async () => {
    assert.equal(sniffImage(await sampleImage('png')), 'png');
    assert.equal(sniffImage(await sampleImage('jpeg')), 'jpeg');
  });

  it('rejects other content', () => {
    assert.equal(sniffImage(new TextEncoder().encode('GIF89a...')), null);
    assert.equal(sniffImage(new Uint8Array(0)), null);
  });
});

describe('convert.image-to-pdf', () => {
  it('builds a one-page PDF from one image, named after it', async () => {
    const result = await executeTool(imageToPdfTool, {
      files: [asInput(await sampleImage('png'), 'scan.png', 'image/png')],
      params: {},
    });

    assert.equal(result.files[0]!.name, 'scan.pdf');
    const opened = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(opened.countPages(), 1);
    } finally {
      opened.destroy();
    }
  });

  it('makes one page per image, in input order', async () => {
    const result = await executeTool(imageToPdfTool, {
      files: [
        asInput(await sampleImage('png'), 'a.png', 'image/png'),
        asInput(await sampleImage('jpeg'), 'b.jpg', 'image/jpeg'),
      ],
      params: {},
    });

    assert.equal(result.files[0]!.name, 'a_+1.pdf');
    const opened = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(opened.countPages(), 2);
    } finally {
      opened.destroy();
    }
  });

  it('sizes fit pages to the image and A4 pages to A4', async () => {
    const png = await sampleImage('png');

    const fit = await executeTool(imageToPdfTool, {
      files: [asInput(png, 'x.png', 'image/png')],
      params: { pageSize: 'fit' },
    });
    const a4 = await executeTool(imageToPdfTool, {
      files: [asInput(png, 'x.png', 'image/png')],
      params: { pageSize: 'a4' },
    });

    const boundsOf = (bytes: Uint8Array) => {
      const opened = openDocument(bytes);
      try {
        return opened.loadPage(0).getBounds();
      } finally {
        opened.destroy();
      }
    };

    // The 72-dpi render of an A4 page is 595×842 px ⇒ fit page is 595×842 pt too.
    const [, , fitW, fitH] = boundsOf(fit.files[0]!.bytes);
    assert.equal(Math.round(fitW), 595);
    assert.equal(Math.round(fitH), 842);

    const [, , a4W] = boundsOf(a4.files[0]!.bytes);
    assert.equal(Math.round(a4W), 595);
  });

  it('rejects a file whose bytes are not an image regardless of its name', async () => {
    await assert.rejects(
      executeTool(imageToPdfTool, {
        files: [asInput(new TextEncoder().encode('not an image'), 'fake.png', 'image/png')],
        params: {},
      }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'UNSUPPORTED_FORMAT');
        return true;
      },
    );
  });
});

describe('convert.pdf-to-text', () => {
  it('extracts the text of every page', async () => {
    const result = await executeTool(pdfToTextTool, { files: [await doc(3)], params: {} });

    assert.equal(result.files[0]!.name, 'report.txt');
    const text = new TextDecoder().decode(result.files[0]!.bytes);
    for (const label of ['P1', 'P2', 'P3']) assert.ok(text.includes(label), `missing ${label}`);
  });

  it('inserts form feeds between pages when asked', async () => {
    const result = await executeTool(pdfToTextTool, {
      files: [await doc(3)],
      params: { pageBreaks: true },
    });
    const text = new TextDecoder().decode(result.files[0]!.bytes);
    assert.equal(text.split('\f').length, 3);
  });

  it('extracts only the selected pages', async () => {
    const result = await executeTool(pdfToTextTool, {
      files: [await doc(3)],
      params: { pages: '2' },
    });
    const text = new TextDecoder().decode(result.files[0]!.bytes);
    assert.ok(text.includes('P2'));
    assert.ok(!text.includes('P1'));
  });
});

describe('convert.pdf-to-markdown', () => {
  it('separates pages with a horizontal rule', async () => {
    const result = await executeTool(pdfToMarkdownTool, { files: [await doc(2)], params: {} });

    assert.equal(result.files[0]!.name, 'report.md');
    const markdown = new TextDecoder().decode(result.files[0]!.bytes);
    assert.ok(markdown.includes('P1'));
    assert.ok(markdown.includes('\n\n---\n\n'));
    assert.ok(markdown.includes('P2'));
  });
});

describe('round trip', () => {
  it('pdf → image → pdf survives', async () => {
    const images = await executeTool(pdfToImageTool, { files: [await doc(2)], params: {} });
    const back = await executeTool(imageToPdfTool, {
      files: images.files.map((f) => asInput(f.bytes, f.name, f.mime)),
      params: {},
    });

    const opened = openDocument(back.files[0]!.bytes);
    try {
      assert.equal(opened.countPages(), 2);
    } finally {
      opened.destroy();
    }
  });
});

describe('watermark + page numbers integration', () => {
  it('watermark text lands in extracted text output', async () => {
    const { addWatermarkTool } = await import('../security/watermark.ts');
    const marked = await executeTool(addWatermarkTool, {
      files: [await doc(2)],
      params: { text: '机密' },
    });
    assert.deepEqual(
      allPageText(marked.files[0]!.bytes).map((t) => t.includes('机密')),
      [true, true],
    );
  });
});
