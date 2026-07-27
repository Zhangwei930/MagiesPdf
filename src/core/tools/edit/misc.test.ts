import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { renderPage } from '../../pdf/render.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import type { ReportRow } from './getInfo.ts';
import { addAttachmentsTool, extractAttachmentsTool } from './attachments.ts';
import { bookmarksTool, parseBookmarkText } from './bookmarks.ts';
import { compareTool, wordDiff } from './compare.ts';
import { addStampTool } from './stamp.ts';
import { showJavascriptTool } from '../security/showJavascript.ts';

const doc = async (pages: number, name = 'report.pdf') =>
  asInput(await samplePdf({ pages, label: (n) => `P${n}` }), name);

const rowsOf = (data: unknown) => data as ReportRow[];

describe('edit.add-attachments + edit.extract-attachments', () => {
  it('round-trips an attachment byte for byte', async () => {
    const payload = new TextEncoder().encode('quarterly figures,100,200');

    const bundled = await executeTool(addAttachmentsTool, {
      files: [await doc(1), asInput(payload, 'figures.csv', 'text/csv')],
      params: {},
    });
    assert.equal(bundled.files[0]!.name, 'report_bundled.pdf');

    const extracted = await executeTool(extractAttachmentsTool, {
      files: [asInput(bundled.files[0]!.bytes, 'bundled.pdf')],
      params: {},
    });

    assert.equal(extracted.files.length, 1);
    assert.equal(extracted.files[0]!.name, 'figures.csv');
    assert.deepEqual([...extracted.files[0]!.bytes], [...payload]);
  });

  it('embeds several attachments at once', async () => {
    const bundled = await executeTool(addAttachmentsTool, {
      files: [
        await doc(1),
        asInput(new TextEncoder().encode('a'), 'a.txt', 'text/plain'),
        asInput(new TextEncoder().encode('{}'), 'b.json', 'application/json'),
      ],
      params: {},
    });

    const extracted = await executeTool(extractAttachmentsTool, {
      files: [asInput(bundled.files[0]!.bytes, 'x.pdf')],
      params: {},
    });
    assert.deepEqual(extracted.files.map((f) => f.name).sort(), ['a.txt', 'b.json']);
  });

  it('demands the PDF come first', async () => {
    await assert.rejects(
      executeTool(addAttachmentsTool, {
        files: [asInput(new TextEncoder().encode('a'), 'a.txt', 'text/plain'), await doc(1)],
        params: {},
      }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_INPUT');
        return true;
      },
    );
  });

  it('reports a document without attachments cleanly', async () => {
    await assert.rejects(
      executeTool(extractAttachmentsTool, { files: [await doc(1)], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'EMPTY_RESULT');
        return true;
      },
    );
  });
});

describe('edit.add-stamp', () => {
  async function stampImage(): Promise<Uint8Array> {
    const source = openDocument(await samplePdf({ pages: 1 }));
    try {
      return renderPage(source, 0, { dpi: 36, format: 'png' }).bytes;
    } finally {
      source.destroy();
    }
  }

  it('stamps selected pages only', async () => {
    // The stamp itself renders as an image XObject; count those per page.
    const result = await executeTool(addStampTool, {
      files: [await doc(3), asInput(await stampImage(), 'seal.png', 'image/png')],
      params: { pages: '2' },
    });

    const opened = openDocument(result.files[0]!.bytes);
    try {
      const imagesOn = (index: number) => {
        const xobjects = opened.loadPage(index).getObject().get('Resources')?.get('XObject');
        if (!xobjects || xobjects.isNull()) return 0;
        let count = 0;
        xobjects.forEach((value: { get(k: string): unknown }) => {
          if (String(value.get('Subtype')) === '/Image') count += 1;
        });
        return count;
      };
      assert.equal(imagesOn(0), 0);
      assert.equal(imagesOn(1), 1);
      assert.equal(imagesOn(2), 0);
    } finally {
      opened.destroy();
    }
  });

  it('rejects an image whose bytes are not an image', async () => {
    await assert.rejects(
      executeTool(addStampTool, {
        files: [await doc(1), asInput(new TextEncoder().encode('x'), 'fake.png', 'image/png')],
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

describe('wordDiff', () => {
  it('reports identical texts as zero-diff', () => {
    assert.deepEqual(wordDiff('a b c', 'a b c'), { added: 0, removed: 0 });
  });

  it('counts additions and removals', () => {
    assert.deepEqual(wordDiff('the old text', 'the new text here'), { added: 2, removed: 1 });
  });

  it('respects multiplicity', () => {
    assert.deepEqual(wordDiff('go go go', 'go'), { added: 0, removed: 2 });
  });
});

describe('edit.compare', () => {
  it('declares identical documents identical', async () => {
    const a = await samplePdf({ pages: 2, label: (n) => `P${n}` });
    const result = await executeTool(compareTool, {
      files: [asInput(a, 'v1.pdf'), asInput(a, 'v2.pdf')],
      params: {},
    });
    assert.match(result.summary?.zh ?? '', /完全一致/);
  });

  it('pinpoints the changed page', async () => {
    const v1 = await samplePdf({ pages: 3, label: (n) => `P${n}` });
    const v2 = await samplePdf({ pages: 3, label: (n) => (n === 2 ? 'CHANGED' : `P${n}`) });

    const result = await executeTool(compareTool, {
      files: [asInput(v1, 'v1.pdf'), asInput(v2, 'v2.pdf')],
      params: {},
    });

    const rows = rowsOf(result.data);
    const changed = rows.filter((r) => r.label.zh.startsWith('第'));
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.label.zh, '第 2 页');
    assert.equal(changed[0]!.value, '+1 / −1');
  });

  it('reports differing page counts', async () => {
    const result = await executeTool(compareTool, {
      files: [await doc(2), await doc(4, 'longer.pdf')],
      params: {},
    });
    assert.match(result.summary?.zh ?? '', /页数不同/);
  });
});

describe('security.show-javascript', () => {
  it('reports a clean document as script-free', async () => {
    const result = await executeTool(showJavascriptTool, { files: [await doc(1)], params: {} });
    assert.match(result.summary?.zh ?? '', /未发现/);
  });

  it('lists a planted script with its source', async () => {
    const opened = openDocument(await samplePdf({ pages: 1 }));
    let planted: Uint8Array;
    try {
      const action = opened.newDictionary();
      action.put('S', opened.newName('JavaScript'));
      action.put('JS', opened.newString('app.alert("gotcha")'));
      opened.getTrailer().get('Root').put('OpenAction', opened.addObject(action));
      planted = saveDocument(opened);
    } finally {
      opened.destroy();
    }

    const result = await executeTool(showJavascriptTool, {
      files: [asInput(planted, 'sus.pdf')],
      params: {},
    });

    assert.match(result.summary?.zh ?? '', /1 段/);
    const rows = rowsOf(result.data);
    assert.ok(rows[0]!.value.includes('gotcha'), rows[0]!.value);
    assert.ok(rows[0]!.label.en.includes('open-action'));
  });
});

describe('parseBookmarkText', () => {
  it('parses flat entries', () => {
    assert.deepEqual(parseBookmarkText('One | 1\nTwo | 3', 5), [
      { level: 0, title: 'One', page: 1 },
      { level: 0, title: 'Two', page: 3 },
    ]);
  });

  it('parses indented children and skips blank lines', () => {
    const lines = parseBookmarkText('Ch 1 | 1\n\n  1.1 | 2\n\tDeep | 3\nCh 2 | 4', 5);
    assert.deepEqual(lines.map((l) => l.level), [0, 1, 1, 0]);
  });

  it('keeps a pipe inside the title', () => {
    assert.deepEqual(parseBookmarkText('A | B | 2', 5), [{ level: 0, title: 'A | B', page: 2 }]);
  });

  it('rejects a missing page', () => {
    assert.throws(() => parseBookmarkText('Just a title', 5), ToolError);
  });

  it('rejects an out-of-range page', () => {
    assert.throws(() => parseBookmarkText('X | 99', 5), ToolError);
  });

  it('rejects an indented first line', () => {
    assert.throws(() => parseBookmarkText('  Child | 1', 5), ToolError);
  });
});

describe('edit.bookmarks', () => {
  it('lists an empty outline', async () => {
    const result = await executeTool(bookmarksTool, {
      files: [await doc(2)],
      params: { action: 'list' },
    });
    assert.match(result.summary?.zh ?? '', /没有书签/);
  });

  it('rebuilds a two-level outline and lists it back', async () => {
    const written = await executeTool(bookmarksTool, {
      files: [await doc(6)],
      params: { action: 'set', entries: '前言 | 1\n第一章 | 2\n  1.1 | 3\n  1.2 | 4\n第二章 | 5' },
    });
    assert.match(written.summary?.zh ?? '', /5 条/);

    const opened = openDocument(written.files[0]!.bytes);
    try {
      const outline = opened.loadOutline() ?? [];
      assert.equal(outline.length, 3);
      assert.equal(outline[1]?.title, '第一章');
      assert.equal((outline[1] as { down?: Array<{ title: string }> }).down?.length, 2);
      assert.equal((outline[1] as { down?: Array<{ title: string }> }).down?.[0]?.title, '1.1');
      assert.equal(outline[2]?.title, '第二章');
      assert.equal(outline[2]?.page, 4);
    } finally {
      opened.destroy();
    }
  });

  it('clears the outline', async () => {
    const withBookmarks = await executeTool(bookmarksTool, {
      files: [await doc(3)],
      params: { action: 'set', entries: 'A | 1\nB | 2' },
    });
    const cleared = await executeTool(bookmarksTool, {
      files: [asInput(withBookmarks.files[0]!.bytes, 'x.pdf')],
      params: { action: 'clear' },
    });

    const opened = openDocument(cleared.files[0]!.bytes);
    try {
      const outline = opened.loadOutline();
      assert.ok(!outline || outline.length === 0, 'outline should be gone');
    } finally {
      opened.destroy();
    }
  });

  it('keeps page content intact through a rebuild', async () => {
    const result = await executeTool(bookmarksTool, {
      files: [await doc(2)],
      params: { action: 'set', entries: 'A | 1' },
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P2']);
  });
});
