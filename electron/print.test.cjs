const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { EventEmitter } = require('node:events');
const {
  createPdfPrinter,
  whenDocumentSettles,
  MAX_PRINTABLE_BYTES,
} = require('./print.cjs');

const pdf = () => Buffer.from('%PDF-1.7 body');

function printer(overrides = {}) {
  const calls = { written: [], removed: [], loaded: [], printed: [], destroyed: 0 };
  const made = createPdfPrinter({
    writeTemp: overrides.writeTemp ?? (async (bytes, fileName) => {
      calls.written.push({ bytes, fileName });
      return { path: `/tmp/magies-print/x/${fileName}`, directory: '/tmp/magies-print/x' };
    }),
    removeTemp: overrides.removeTemp ?? (async (directory) => {
      calls.removed.push(directory);
    }),
    openWindow: overrides.openWindow ?? (async (filePath) => {
      calls.loaded.push(filePath);
      return {
        print: async (options) => {
          calls.printed.push(options);
          return { printed: true };
        },
        destroy: () => {
          calls.destroyed += 1;
        },
      };
    }),
  });
  return { printer: made, calls };
}

describe('printing the document rather than the app', () => {
  /**
   * `event.sender.print()` printed the renderer: the title bar, the toolbar,
   * the sidebar, the AI panel — and only the pages virtualization happened to
   * have mounted. What has to be printed is the document's own bytes, laid out
   * by the engine that already knows how to render a PDF. See issue #27.
   */
  it('writes the bytes out and prints those', async () => {
    const { printer: p, calls } = printer();

    assert.deepEqual(await p.print(pdf(), { name: 'report.pdf' }), { printed: true });

    assert.equal(calls.written.length, 1);
    assert.deepEqual(calls.loaded, ['/tmp/magies-print/x/report.pdf']);
    assert.equal(calls.printed.length, 1);
  });

  /**
   * The acceptance criterion behind #27: a document longer than the viewer's
   * virtualization window must print in full. Nothing here counts pages —
   * that is the point. What is handed over is the whole byte stream, so the
   * page count is decided by the document rather than by how far the user had
   * scrolled. A test that asserted a page count would be testing Chromium.
   */
  it('hands over the whole document, not the part that was on screen', async () => {
    const { printer: p, calls } = printer();
    const long = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(500_000, 7)]);

    await p.print(long, { name: 'long.pdf' });

    assert.equal(calls.written.length, 1);
    assert.equal(Buffer.compare(Buffer.from(calls.written[0].bytes), long), 0);
  });

  /** The print job is named after the page, which is named after the file. */
  it('keeps the document name, so the print queue is readable', async () => {
    const { printer: p, calls } = printer();
    await p.print(pdf(), { name: '季度报告.pdf' });
    assert.equal(calls.written[0].fileName, '季度报告.pdf');
  });

  it('gives an unusable name a safe one rather than refusing to print', async () => {
    const { printer: p, calls } = printer();

    await p.print(pdf(), { name: '../../etc/passwd' });
    await p.print(pdf(), { name: '' });

    assert.deepEqual(
      calls.written.map((entry) => entry.fileName),
      ['document.pdf', 'document.pdf'],
    );
  });

  it('prints a document whose name is not a pdf under one that is', async () => {
    const { printer: p, calls } = printer();
    await p.print(pdf(), { name: 'result' });
    assert.equal(calls.written[0].fileName, 'result.pdf');
  });

  it('removes the copy it made, and the window, once printed', async () => {
    const { printer: p, calls } = printer();

    await p.print(pdf(), { name: 'report.pdf' });

    assert.deepEqual(calls.removed, ['/tmp/magies-print/x']);
    assert.equal(calls.destroyed, 1);
  });

  /**
   * The temp copy is the user's document. Leaving it behind because the print
   * dialog was cancelled would put a copy of every document the user thought
   * better of printing in temp, decrypted, for the rest of the session.
   */
  it('removes the copy when the user cancels the dialog', async () => {
    const { printer: p, calls } = printer({
      openWindow: async () => ({
        print: async () => ({ printed: false, reason: 'cancelled' }),
        destroy: () => {
          calls.destroyed += 1;
        },
      }),
    });

    assert.deepEqual(await p.print(pdf(), { name: 'report.pdf' }), {
      printed: false,
      reason: 'cancelled',
    });
    assert.deepEqual(calls.removed, ['/tmp/magies-print/x']);
    assert.equal(calls.destroyed, 1);
  });

  it('removes the copy and the window when printing throws', async () => {
    const { printer: p, calls } = printer({
      openWindow: async () => ({
        print: async () => {
          throw new Error('no printers configured');
        },
        destroy: () => {
          calls.destroyed += 1;
        },
      }),
    });

    await assert.rejects(() => p.print(pdf(), { name: 'report.pdf' }), /no printers/);
    assert.deepEqual(calls.removed, ['/tmp/magies-print/x']);
    assert.equal(calls.destroyed, 1);
  });

  it('removes the copy when the window will not even open', async () => {
    const { printer: p, calls } = printer({
      openWindow: async () => {
        throw new Error('the pdf viewer failed to load');
      },
    });

    await assert.rejects(() => p.print(pdf(), { name: 'report.pdf' }), /failed to load/);
    assert.deepEqual(calls.removed, ['/tmp/magies-print/x']);
  });

  /**
   * The bytes arrive from the renderer, so they are input, not a fact. A path
   * is never accepted here at all — printing prints what the tab is showing,
   * including edits that were never saved.
   */
  describe('what it refuses', () => {
    it('refuses something that is not a PDF', async () => {
      const { printer: p, calls } = printer();
      await assert.rejects(() => p.print(Buffer.from('MZ  '), { name: 'a.pdf' }), /not a pdf/i);
      assert.deepEqual(calls.written, [], 'nothing reaches the disk');
    });

    it('refuses an empty document', async () => {
      const { printer: p } = printer();
      await assert.rejects(() => p.print(Buffer.alloc(0), { name: 'a.pdf' }), /not a pdf/i);
    });

    it('refuses something that is not bytes at all', async () => {
      const { printer: p } = printer();
      await assert.rejects(() => p.print('/etc/passwd', { name: 'a.pdf' }), /not a pdf/i);
      await assert.rejects(() => p.print(undefined, { name: 'a.pdf' }), /not a pdf/i);
    });

    it('refuses a document too large to be one', async () => {
      const { printer: p } = printer();
      // A real PDF, claiming a size no one prints — allocating one would cost
      // half a gigabyte to prove a comparison.
      const huge = pdf();
      Object.defineProperty(huge, 'byteLength', { value: MAX_PRINTABLE_BYTES + 1 });
      await assert.rejects(() => p.print(huge, { name: 'a.pdf' }), /too large/i);
    });
  });
});

/**
 * Loading a PDF finishes long before the PDF is there to print.
 *
 * Measured on a seven-page document: `did-finish-load` at 179ms — printing
 * then produces one blank page. The viewer starts a second load of its own,
 * `did-stop-loading` fires again at 468ms, and only about 150ms after *that*
 * does the whole document print. Nothing announces the last step, so what is
 * waited for is the page going quiet and staying quiet.
 */
describe('waiting for the document to be there to print', () => {
  function settling(overrides = {}) {
    const contents = new EventEmitter();
    const timers = new Map();
    let next = 1;
    let now = 0;
    const clock = {
      setTimeout: (run, ms) => {
        const handle = next++;
        timers.set(handle, { at: now + ms, run });
        return handle;
      },
      clearTimeout: (handle) => timers.delete(handle),
    };
    const advance = (ms) => {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.run();
        }
      }
    };
    let settled = false;
    const waiting = whenDocumentSettles(contents, {
      clock,
      settleMs: 500,
      timeoutMs: 10_000,
      ...overrides,
    }).then(() => {
      settled = true;
    });
    return { contents, advance, waiting, settled: () => settled, outstanding: () => timers.size };
  }

  it('waits for the page to go quiet', async () => {
    const s = settling();

    s.advance(499);
    await Promise.resolve();
    assert.equal(s.settled(), false);

    s.advance(1);
    await s.waiting;
    assert.equal(s.settled(), true);
  });

  it('starts waiting again when the viewer loads something of its own', async () => {
    const s = settling();

    s.advance(400);
    s.contents.emit('did-start-loading');
    s.advance(400);
    await Promise.resolve();
    assert.equal(s.settled(), false, 'the second load reset the wait');

    s.advance(100);
    await s.waiting;
    assert.equal(s.settled(), true);
  });

  it('treats a new frame as more loading, because that is what it is', async () => {
    const s = settling();

    s.advance(400);
    s.contents.emit('frame-created');
    s.advance(400);
    await Promise.resolve();
    assert.equal(s.settled(), false);
  });

  /**
   * A viewer that never goes quiet must not mean a document that never
   * prints. Printing something is the point; the wait is only insurance.
   */
  it('prints anyway rather than waiting forever', async () => {
    const s = settling();

    for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
      s.contents.emit('did-start-loading');
      s.advance(100);
    }

    await s.waiting;
    assert.equal(s.settled(), true);
  });

  it('leaves no timer behind once it has answered', async () => {
    const s = settling();
    s.advance(500);
    await s.waiting;
    assert.equal(s.outstanding(), 0);
  });

  it('stops listening once it has answered, so a later load changes nothing', async () => {
    const s = settling();
    s.advance(500);
    await s.waiting;
    assert.equal(s.contents.listenerCount('did-start-loading'), 0);
    assert.equal(s.contents.listenerCount('frame-created'), 0);
  });
});
