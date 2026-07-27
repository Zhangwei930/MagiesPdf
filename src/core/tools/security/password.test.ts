import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { openDocument } from '../../pdf/document.ts';
import { allPageText, asInput, encryptPdf, samplePdf } from '../../testing/fixtures.ts';
import { addPasswordTool, removePasswordTool, resolveOwnerPassword } from './password.ts';

describe('resolveOwnerPassword', () => {
  it('uses the supplied owner password when there is one', () => {
    assert.equal(resolveOwnerPassword('owner', 'user', ['print']), 'owner');
  });

  it('falls back to the user password when nothing is restricted', () => {
    assert.equal(resolveOwnerPassword('', 'user', []), 'user');
  });

  it('generates a distinct random owner password when restrictions are set', () => {
    const generated = resolveOwnerPassword('', 'user', ['print']);
    assert.notEqual(generated, 'user');
    assert.ok(generated.length >= 32, `expected a long random value, got "${generated}"`);
    assert.notEqual(generated, resolveOwnerPassword('', 'user', ['print']));
  });
});

const doc = async (pages = 2, name = 'report.pdf') =>
  asInput(await samplePdf({ pages, label: (n) => `P${n}` }), name);

function inspect<T>(bytes: Uint8Array, password: string, read: (d: ReturnType<typeof openDocument>) => T): T {
  const opened = openDocument(bytes, password);
  try {
    return read(opened);
  } finally {
    opened.destroy();
  }
}

describe('security.add-password', () => {
  it('encrypts so the file can no longer be opened without a password', async () => {
    const result = await executeTool(addPasswordTool, {
      files: [await doc()],
      params: { userPassword: 'hunter2' },
    });

    assert.throws(() => openDocument(result.files[0]!.bytes), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'PASSWORD_REQUIRED');
      return true;
    });
  });

  it('opens with the password it was given', async () => {
    const result = await executeTool(addPasswordTool, {
      files: [await doc(3)],
      params: { userPassword: 'hunter2' },
    });

    assert.deepEqual(allPageText(result.files[0]!.bytes, 'hunter2'), ['P1', 'P2', 'P3']);
  });

  it('rejects a wrong password', async () => {
    const result = await executeTool(addPasswordTool, {
      files: [await doc()],
      params: { userPassword: 'right' },
    });

    assert.throws(() => openDocument(result.files[0]!.bytes, 'wrong'), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      assert.equal(e.code, 'WRONG_PASSWORD');
      return true;
    });
  });

  it('applies the selected restrictions', async () => {
    const result = await executeTool(addPasswordTool, {
      files: [await doc()],
      params: { userPassword: 'pw', denied: ['print', 'copy'] },
    });

    inspect(result.files[0]!.bytes, 'pw', (d) => {
      assert.equal(d.hasPermission('print'), false);
      assert.equal(d.hasPermission('copy'), false);
      assert.equal(d.hasPermission('annotate'), true);
    });
  });

  it('leaves every permission granted when none are ticked', async () => {
    const result = await executeTool(addPasswordTool, {
      files: [await doc()],
      params: { userPassword: 'pw' },
    });

    inspect(result.files[0]!.bytes, 'pw', (d) => {
      assert.equal(d.hasPermission('print'), true);
      assert.equal(d.hasPermission('copy'), true);
    });
  });

  it('can restrict actions without setting an open password', async () => {
    const result = await executeTool(addPasswordTool, {
      files: [await doc()],
      params: { ownerPassword: 'owner', denied: ['print'] },
    });

    // An empty user password means the file still opens freely.
    inspect(result.files[0]!.bytes, '', (d) => {
      assert.equal(d.needsPassword(), false);
      assert.equal(d.hasPermission('print'), false);
    });
  });

  it('refuses a no-op request', async () => {
    await assert.rejects(
      executeTool(addPasswordTool, { files: [await doc()], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_PARAM');
        return true;
      },
    );
  });

  it('re-encrypts a document that was already encrypted', async () => {
    const locked = asInput(
      encryptPdf(await samplePdf({ pages: 1, label: () => 'P1' }), { userPassword: 'old' }),
      'l.pdf',
    );

    const result = await executeTool(addPasswordTool, {
      files: [locked],
      params: { password: 'old', userPassword: 'new' },
    });

    assert.deepEqual(allPageText(result.files[0]!.bytes, 'new'), ['P1']);
    assert.throws(() => openDocument(result.files[0]!.bytes, 'old'), ToolError);
  });

  it('supports AES-128 and RC4-128 for legacy readers', async () => {
    for (const method of ['aes-128', 'rc4-128']) {
      const result = await executeTool(addPasswordTool, {
        files: [await doc(1)],
        params: { userPassword: 'pw', method },
      });
      assert.deepEqual(allPageText(result.files[0]!.bytes, 'pw'), ['P1'], `${method} round-trip`);
    }
  });
});

describe('security.remove-password', () => {
  it('produces a file that opens without a password', async () => {
    const locked = asInput(
      encryptPdf(await samplePdf({ pages: 2, label: (n) => `P${n}` }), { userPassword: 'pw' }),
      'locked.pdf',
    );

    const result = await executeTool(removePasswordTool, {
      files: [locked],
      params: { password: 'pw' },
    });

    inspect(result.files[0]!.bytes, '', (d) => assert.equal(d.needsPassword(), false));
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1', 'P2']);
  });

  it('clears permission restrictions along with the password', async () => {
    const restricted = asInput(
      encryptPdf(await samplePdf({ pages: 1 }), {
        userPassword: 'pw',
        // Deny print + print-hires.
        permissions: ~(4 | 2048),
      }),
      'restricted.pdf',
    );

    const result = await executeTool(removePasswordTool, {
      files: [restricted],
      params: { password: 'pw' },
    });

    inspect(result.files[0]!.bytes, '', (d) => assert.equal(d.hasPermission('print'), true));
  });

  it('accepts the owner password too', async () => {
    const locked = asInput(
      encryptPdf(await samplePdf({ pages: 1, label: () => 'P1' }), {
        userPassword: 'u',
        ownerPassword: 'o',
      }),
      'l.pdf',
    );

    const result = await executeTool(removePasswordTool, { files: [locked], params: { password: 'o' } });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['P1']);
  });

  it('reports a wrong password clearly', async () => {
    const locked = asInput(
      encryptPdf(await samplePdf({ pages: 1 }), { userPassword: 'pw' }),
      'l.pdf',
    );

    await assert.rejects(
      executeTool(removePasswordTool, { files: [locked], params: { password: 'nope' } }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'WRONG_PASSWORD');
        return true;
      },
    );
  });

  it('requires a password to be entered at all', async () => {
    await assert.rejects(
      executeTool(removePasswordTool, { files: [await doc()], params: {} }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.code, 'INVALID_PARAM');
        return true;
      },
    );
  });
});
