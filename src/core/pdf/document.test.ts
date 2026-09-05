import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../errors.ts';
import { allPageText, encryptPdf, samplePdf } from '../testing/fixtures.ts';
import {
  countPages,
  decryptToBytes,
  loadForEditing,
  openDocument,
  saveDocument,
  saveEdited,
} from './document.ts';
import { permissionsToBitfield } from './permissions.ts';

describe('openDocument', () => {
  it('opens an unencrypted document', async () => {
    const doc = openDocument(await samplePdf({ pages: 4 }));
    try {
      assert.equal(doc.countPages(), 4);
    } finally {
      doc.destroy();
    }
  });

  it('rejects bytes that are not a PDF', () => {
    assert.throws(() => openDocument(new TextEncoder().encode('not a pdf at all')), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'CORRUPT_DOCUMENT');
      return true;
    });
  });

  it('demands a password for an encrypted document', async () => {
    const encrypted = encryptPdf(await samplePdf());
    assert.throws(() => openDocument(encrypted), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'PASSWORD_REQUIRED');
      return true;
    });
  });

  it('reports a wrong password distinctly from a missing one', async () => {
    const encrypted = encryptPdf(await samplePdf(), { userPassword: 'right' });
    assert.throws(() => openDocument(encrypted, 'wrong'), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'WRONG_PASSWORD');
      return true;
    });
  });

  it('opens an encrypted document with the user password', async () => {
    const encrypted = encryptPdf(await samplePdf({ pages: 2 }), { userPassword: 'letmein' });
    const doc = openDocument(encrypted, 'letmein');
    try {
      assert.equal(doc.countPages(), 2);
    } finally {
      doc.destroy();
    }
  });

  it('opens an encrypted document with the owner password', async () => {
    const encrypted = encryptPdf(await samplePdf({ pages: 2 }), {
      userPassword: 'u',
      ownerPassword: 'o',
    });
    const doc = openDocument(encrypted, 'o');
    try {
      assert.equal(doc.countPages(), 2);
    } finally {
      doc.destroy();
    }
  });
});

describe('saveDocument', () => {
  it('does not carry the source encryption into the output', async () => {
    const encrypted = encryptPdf(await samplePdf(), { userPassword: 'pw' });
    const doc = openDocument(encrypted, 'pw');
    let saved: Uint8Array;
    try {
      saved = saveDocument(doc);
    } finally {
      doc.destroy();
    }

    // Regression guard: MuPDF's default is `encrypt=keep`, which would silently
    // produce a still-encrypted file from a "remove password" operation.
    const reopened = openDocument(saved);
    try {
      assert.equal(reopened.needsPassword(), false);
    } finally {
      reopened.destroy();
    }
  });

  it('applies encryption and permissions when asked', async () => {
    const doc = openDocument(await samplePdf());
    let saved: Uint8Array;
    try {
      saved = saveDocument(doc, {
        encryption: {
          method: 'aes-256',
          userPassword: 'u',
          ownerPassword: 'o',
          permissions: permissionsToBitfield(['print', 'copy']),
        },
      });
    } finally {
      doc.destroy();
    }

    const reopened = openDocument(saved, 'u');
    try {
      assert.equal(reopened.hasPermission('print'), false);
      assert.equal(reopened.hasPermission('copy'), false);
      assert.equal(reopened.hasPermission('annotate'), true);
    } finally {
      reopened.destroy();
    }
  });

  it('writes streams uncompressed when asked, and compressed otherwise', async () => {
    const bytes = await samplePdf({ pages: 10, bodyLines: 40 });
    const doc = openDocument(bytes);
    try {
      const compressed = saveDocument(doc, { compress: true, compressFonts: true }).length;
      const uncompressed = saveDocument(doc, { decompress: true }).length;
      assert.ok(
        compressed < uncompressed,
        `expected compressed ${compressed} < uncompressed ${uncompressed}`,
      );
    } finally {
      doc.destroy();
    }
  });

  it('returns bytes that own their buffer, not a view into the WASM heap', async () => {
    const doc = openDocument(await samplePdf({ pages: 2 }));
    let saved: Uint8Array;
    try {
      saved = saveDocument(doc);
    } finally {
      doc.destroy();
    }

    // MuPDF's `asUint8Array()` returns a subarray of its heap. Handing that out
    // would dangle once the buffer is freed, and cannot cross a worker boundary.
    assert.equal(saved.byteOffset, 0, 'byteOffset should be 0 for an owned buffer');
    assert.equal(
      saved.buffer.byteLength,
      saved.byteLength,
      'buffer should be sized exactly to the document, not the whole WASM heap',
    );

    // And the bytes must still be a readable PDF after the document is gone.
    assert.deepEqual(allPageText(saved), ['Page 1', 'Page 2']);
  });

  it('refuses to compress and decompress in the same save', async () => {
    const doc = openDocument(await samplePdf({ pages: 1 }));
    try {
      assert.throws(() => saveDocument(doc, { compress: true, decompress: true }), (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_PARAM');
        return true;
      });
    } finally {
      doc.destroy();
    }
  });
});

describe('decryptToBytes', () => {
  it('returns the original bytes untouched when nothing is encrypted', async () => {
    const bytes = await samplePdf();
    assert.equal(decryptToBytes(bytes), bytes);
  });

  it('returns loadable plain bytes for an encrypted document', async () => {
    const encrypted = encryptPdf(await samplePdf({ pages: 3 }), { userPassword: 'pw' });
    const plain = decryptToBytes(encrypted, 'pw');
    assert.deepEqual(allPageText(plain), ['Page 1', 'Page 2', 'Page 3']);
  });
});

describe('loadForEditing', () => {
  it('hands an encrypted document to pdf-lib without the caller knowing', async () => {
    const encrypted = encryptPdf(await samplePdf({ pages: 5 }), { userPassword: 'pw' });
    const doc = await loadForEditing(encrypted, 'pw');
    assert.equal(doc.getPageCount(), 5);
  });

  it('round-trips through pdf-lib without losing pages', async () => {
    const doc = await loadForEditing(await samplePdf({ pages: 3 }));
    doc.removePage(1);
    assert.deepEqual(allPageText(await saveEdited(doc)), ['Page 1', 'Page 3']);
  });
});

describe('countPages', () => {
  it('counts pages of an encrypted document', async () => {
    const encrypted = encryptPdf(await samplePdf({ pages: 7 }), { userPassword: 'pw' });
    assert.equal(countPages(encrypted, 'pw'), 7);
  });
});

/**
 * MuPDF takes its write options as one comma-separated string, and there is
 * no escape for a comma inside a value. Its own object form is worse than
 * the string: it replaces commas with colons, so a document would be
 * encrypted with a password the user never typed and could never open.
 *
 * Only the comma is a problem — `=`, quotes, backslashes, spaces and
 * non-ASCII all survive, and are covered here so the guard stays narrow.
 */
describe('a password the option string cannot carry', () => {
  const encrypt = async (userPassword: string) => {
    const doc = openDocument(await samplePdf({ pages: 1 }));
    try {
      return saveDocument(doc, {
        encryption: {
          method: 'aes-256',
          userPassword,
          ownerPassword: userPassword,
          permissions: -1,
        },
      });
    } finally {
      doc.destroy();
    }
  };

  it('refuses a comma rather than mangling it', async () => {
    await assert.rejects(encrypt('alpha,beta'), (error: unknown) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.code, 'INVALID_PARAM');
      return true;
    });
  });

  it('never puts the password in the message', async () => {
    await assert.rejects(encrypt('alpha,beta'), (error: unknown) => {
      const text = `${(error as Error).message} ${JSON.stringify((error as ToolError).userMessage)}`;
      assert.ok(!text.includes('alpha'), `password leaked: ${text}`);
      return true;
    });
  });

  it('leaves every other character alone', async () => {
    for (const password of ['a=b', 'a:b', 'a b', 'a\\b', '中文密码', "a'b"]) {
      await assert.doesNotReject(encrypt(password), `rejected ${password}`);
    }
  });
});
