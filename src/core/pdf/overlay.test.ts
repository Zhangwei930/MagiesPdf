import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDocument, saveDocument } from './document.ts';
import { allPageText, samplePdf } from '../testing/fixtures.ts';
import {
  appendContentStream,
  colorOperands,
  hexUtf16,
  measureText,
  placeTextAtPoint,
  placeTextOnPage,
  stampTextOnPage,
} from './overlay.ts';

describe('hexUtf16', () => {
  it('encodes ASCII as UTF-16BE', () => {
    assert.equal(hexUtf16('AB'), '00410042');
  });

  it('encodes CJK', () => {
    assert.equal(hexUtf16('机'), '673a');
  });

  it('encodes astral code points as surrogate pairs', () => {
    assert.equal(hexUtf16('😀'), 'd83dde00');
  });
});

describe('colorOperands', () => {
  it('converts hex to 0..1 rgb', () => {
    assert.equal(colorOperands('#ff0000'), '1.000 0.000 0.000 rg');
    assert.equal(colorOperands('#000000'), '0.000 0.000 0.000 rg');
  });
});

describe('measureText', () => {
  it('scales linearly with size', () => {
    const at10 = measureText('Hello', 10);
    const at20 = measureText('Hello', 20);
    assert.ok(at10 > 0);
    assert.ok(Math.abs(at20 - at10 * 2) < 0.001);
  });

  it('measures CJK wider than a Latin letter', () => {
    assert.ok(measureText('机', 12) > measureText('i', 12));
  });
});

describe('appendContentStream', () => {
  it('keeps the original content when Contents is a single stream', async () => {
    const doc = openDocument(await samplePdf({ pages: 1, label: () => 'BODY' }));
    try {
      appendContentStream(doc, doc.loadPage(0).getObject(), '');
      const saved = saveDocument(doc);
      assert.deepEqual(allPageText(saved), ['BODY']);
    } finally {
      doc.destroy();
    }
  });

  it('keeps the original content when Contents is already an array', async () => {
    // Regression guard: nesting the existing array inside a new one corrupts
    // the page ("object is not a stream") and silently drops the body.
    const doc = openDocument(await samplePdf({ pages: 1, label: () => 'BODY' }));
    try {
      const pageObj = doc.loadPage(0).getObject();
      appendContentStream(doc, pageObj, '');
      // Second append sees the array form produced by the first.
      appendContentStream(doc, pageObj, '');
      const saved = saveDocument(doc);
      assert.deepEqual(allPageText(saved), ['BODY']);
    } finally {
      doc.destroy();
    }
  });
});

describe('stampTextOnPage', () => {
  it('adds the watermark text while preserving the body', async () => {
    const doc = openDocument(await samplePdf({ pages: 1, label: () => 'BODY' }));
    try {
      stampTextOnPage(doc, 0, {
        text: '机密 CONFIDENTIAL',
        size: 48,
        color: '#3344ff',
        opacity: 0.15,
        rotateDegrees: 45,
        tile: false,
      });
      const text = allPageText(saveDocument(doc))[0] ?? '';
      assert.ok(text.includes('BODY'), `body lost: ${text}`);
      assert.ok(text.includes('机密 CONFIDENTIAL'), `watermark missing: ${text}`);
    } finally {
      doc.destroy();
    }
  });

  it('tiles the text more than once', async () => {
    const doc = openDocument(await samplePdf({ pages: 1 }));
    try {
      stampTextOnPage(doc, 0, {
        text: 'WM',
        size: 24,
        color: '#888888',
        opacity: 0.2,
        rotateDegrees: 45,
        tile: true,
      });
      const text = allPageText(saveDocument(doc))[0] ?? '';
      const occurrences = text.split('WM').length - 1;
      assert.ok(occurrences >= 4, `expected a grid, found ${occurrences} stamps`);
    } finally {
      doc.destroy();
    }
  });

  it('stamps two different pages independently', async () => {
    const doc = openDocument(await samplePdf({ pages: 2, label: (n) => `P${n}` }));
    try {
      stampTextOnPage(doc, 0, {
        text: 'ONE',
        size: 30,
        color: '#000000',
        opacity: 0.5,
        rotateDegrees: 0,
        tile: false,
      });
      const texts = allPageText(saveDocument(doc));
      assert.ok(texts[0]?.includes('ONE'));
      assert.ok(!texts[1]?.includes('ONE'), 'page 2 must stay clean');
    } finally {
      doc.destroy();
    }
  });
});

describe('placeTextOnPage', () => {
  it('places the text and keeps the body', async () => {
    const doc = openDocument(await samplePdf({ pages: 1, label: () => 'BODY' }));
    try {
      placeTextOnPage(doc, 0, {
        text: '第 1 页',
        size: 10,
        color: '#333333',
        anchor: 'bottom-center',
        margin: 24,
      });
      const text = allPageText(saveDocument(doc))[0] ?? '';
      assert.ok(text.includes('BODY'));
      assert.ok(text.includes('第 1 页'));
    } finally {
      doc.destroy();
    }
  });

  it('anchors right of centre for a right anchor', async () => {
    const doc = openDocument(await samplePdf({ pages: 1 }));
    try {
      placeTextOnPage(doc, 0, {
        text: '7',
        size: 10,
        color: '#333333',
        anchor: 'bottom-right',
        margin: 24,
      });
      const saved = saveDocument(doc);

      const reopened = openDocument(saved);
      try {
        const json = JSON.parse(
          reopened.loadPage(0).toStructuredText('preserve-whitespace').asJSON(),
        ) as { blocks: Array<{ lines: Array<{ text: string; bbox: { x: number } }> }> };
        const line = json.blocks.flatMap((b) => b.lines).find((l) => l.text.trim() === '7');
        assert.ok(line, 'page number line not found');
        assert.ok(line.bbox.x > 297, `expected right side, got x=${line.bbox.x}`);
      } finally {
        reopened.destroy();
      }
    } finally {
      doc.destroy();
    }
  });
});

describe('placeTextAtPoint', () => {
  it('places directly entered text at the clicked PDF point', async () => {
    const doc = openDocument(await samplePdf({ pages: 1, label: () => 'BODY' }));
    try {
      placeTextAtPoint(doc, 0, {
        text: '直接编辑',
        matrix: [1, 0, 0, 1, 96, 640],
        size: 16,
        color: '#2255aa',
      });

      const text = allPageText(saveDocument(doc))[0] ?? '';
      assert.ok(text.includes('BODY'));
      assert.ok(text.includes('直接编辑'));
    } finally {
      doc.destroy();
    }
  });
});
