import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import forge from 'node-forge';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import type { ReportRow } from '../edit/getInfo.ts';
import {
  certificateSignTool,
  restoreStrippedPadding,
  signPdfWithP12,
  verifyPdfSignatures,
} from './certificateSign.ts';
import { inspectSignaturesTool } from './inspectSignatures.ts';

function testP12(password: string): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attributes = [{ name: 'commonName', value: 'MagiesPdf Test Signer' }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [certificate], password, {
    algorithm: '3des',
  });
  return new Uint8Array(
    Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
  );
}

describe('PDF certificate signatures', () => {
  it('signs with an in-memory P12 and verifies document integrity', async () => {
    const password = 'test-password';
    const source = await samplePdf({ pages: 1 });
    const signed = await signPdfWithP12(source, testP12(password), password, {
      name: 'MagiesPdf Test Signer',
      reason: 'Automated test',
      location: 'Local',
      contactInfo: '',
    });

    const results = await verifyPdfSignatures(signed);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.cryptographicallyValid, true);
    assert.equal(results[0]?.certificateTrusted, false);
    assert.match(results[0]?.subject ?? '', /MagiesPdf Test Signer/);

    const inspection = await executeTool(inspectSignaturesTool, {
      files: [asInput(signed, 'signed.pdf')],
      params: {},
    });
    const rows = inspection.data as ReportRow[];
    assert.equal(
      rows.find((row) => row.label.en === 'Cryptographic integrity · signature 1')?.value,
      'Valid (certificate trust not evaluated)',
    );

    const tampered = signed.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    const altered = await verifyPdfSignatures(tampered);
    assert.equal(altered[0]?.cryptographicallyValid, false);

    await assert.rejects(
      signPdfWithP12(signed, testP12(password), password, {
        name: 'Second signer',
        reason: '',
        location: '',
        contactInfo: '',
      }),
      /already contains a digital signature/i,
    );
  });
});

/**
 * `/Contents` is padded with `00` to a fixed placeholder size, and extracting
 * it strips every trailing zero. When the signature's own last byte is `00`,
 * the real DER loses it and stops parsing — a correctly signed document was
 * then reported as having an invalid signature.
 *
 * Measured before the fix: one failure in ten signings, each reporting
 * "Invalid CMS signature encoding". Probability is a poor thing to assert on,
 * so this checks the arithmetic directly.
 */
describe('a signature whose last byte was stripped as padding', () => {
  it('puts back exactly what the DER says is missing', () => {
    // SEQUENCE, 4 content bytes, last of which was a zero that got stripped.
    const stripped = Buffer.from([0x30, 0x04, 0x01, 0x02, 0x03]);
    const restored = restoreStrippedPadding(stripped);
    assert.equal(restored.length, 6);
    assert.deepEqual([...restored], [0x30, 0x04, 0x01, 0x02, 0x03, 0x00]);
  });

  it('handles the long-form length a real CMS blob uses', () => {
    // SEQUENCE, 0x82 = two length bytes, 0x0102 = 258 content bytes.
    const header = Buffer.from([0x30, 0x82, 0x01, 0x02]);
    const stripped = Buffer.concat([header, Buffer.alloc(256, 0x41)]);
    assert.equal(restoreStrippedPadding(stripped).length, 4 + 258);
  });

  it('leaves a complete signature untouched', () => {
    const whole = Buffer.from([0x30, 0x03, 0x01, 0x02, 0x03]);
    assert.equal(restoreStrippedPadding(whole), whole);
  });

  /** A malformed signature must still fail, not be padded into looking valid. */
  it('does not invent length for something that is not DER', () => {
    for (const bytes of [[], [0x30], [0x30, 0x88, 0x01], [0x30, 0x80]]) {
      const input = Buffer.from(bytes);
      assert.equal(restoreStrippedPadding(input), input, JSON.stringify(bytes));
    }
  });
});

/**
 * The tool itself, not just the functions under it.
 *
 * Everything above tests `signPdfWithP12` and `verifyPdfSignatures` directly,
 * so the tool's own `run` — which file is the PDF and which the certificate,
 * the passwords, the output name, the error wrapping — had never executed. It
 * was the only one of the sixty-one tools in that position, and it is the one
 * that signs documents.
 */
describe('security.certificate-sign as a tool', () => {
  const PASSWORD = 'cert-password';

  it('picks the certificate out of the files and signs the PDF with it', async () => {
    const result = await executeTool(certificateSignTool, {
      files: [
        asInput(await samplePdf({ pages: 1 }), 'contract.pdf'),
        asInput(testP12(PASSWORD), 'signer.p12', 'application/x-pkcs12'),
      ],
      params: { certificatePassword: PASSWORD, signerName: 'MagiesPdf Test Signer' },
    });

    assert.equal(result.files[0]?.name, 'contract_certificate_signed.pdf');
    const [signature] = await verifyPdfSignatures(result.files[0]!.bytes);
    assert.equal(signature?.cryptographicallyValid, true);
    assert.match(signature?.subject ?? '', /MagiesPdf Test Signer/);
  });

  it('names the certificate as missing when two files arrive without one', async () => {
    await assert.rejects(
      async () => executeTool(certificateSignTool, {
        files: [
          asInput(await samplePdf({ pages: 1 }), 'contract.pdf'),
          asInput(await samplePdf({ pages: 1 }), 'notes.pdf'),
        ],
        params: { certificatePassword: PASSWORD },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_INPUT');
        assert.match((error as { message: string }).message, /P12 or PFX/i);
        return true;
      },
    );
  });

  it('takes the certificate whichever order the files arrive in', async () => {
    const result = await executeTool(certificateSignTool, {
      files: [
        asInput(testP12(PASSWORD), 'signer.pfx', 'application/x-pkcs12'),
        asInput(await samplePdf({ pages: 1 }), 'contract.pdf'),
      ],
      params: { certificatePassword: PASSWORD, signerName: 'Signer' },
    });
    assert.equal(result.files[0]?.name, 'contract_certificate_signed.pdf');
  });

  /**
   * Caught by the input spec before `run` is reached — the tool declares it
   * needs two files. That is a better message than the one inside
   * `certificateInput`, which only speaks when two files arrive and neither is
   * a certificate.
   */
  it('says a certificate is missing rather than failing obscurely', async () => {
    await assert.rejects(
      async () => executeTool(certificateSignTool, {
        files: [asInput(await samplePdf({ pages: 1 }), 'contract.pdf')],
        params: { certificatePassword: PASSWORD },
      }),
      (error: unknown) => {
        assert.match((error as { message: string }).message, /at least 2 file/i);
        return true;
      },
    );
  });

  /**
   * The wrong password is the mistake a person actually makes, and forge
   * throws something unreadable for it. It has to come back as a typed error
   * the panel can explain.
   */
  it('turns a wrong certificate password into a typed error', async () => {
    await assert.rejects(
      async () => executeTool(certificateSignTool, {
        files: [
          asInput(await samplePdf({ pages: 1 }), 'contract.pdf'),
          asInput(testP12(PASSWORD), 'signer.p12', 'application/x-pkcs12'),
        ],
        params: { certificatePassword: 'wrong' },
      }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_INPUT',
    );
  });

  it('refuses to sign a document that already carries a signature', async () => {
    const once = await executeTool(certificateSignTool, {
      files: [
        asInput(await samplePdf({ pages: 1 }), 'contract.pdf'),
        asInput(testP12(PASSWORD), 'signer.p12', 'application/x-pkcs12'),
      ],
      params: { certificatePassword: PASSWORD, signerName: 'Signer' },
    });

    await assert.rejects(
      () => executeTool(certificateSignTool, {
        files: [
          asInput(once.files[0]!.bytes, 'contract_certificate_signed.pdf'),
          asInput(testP12(PASSWORD), 'signer.p12', 'application/x-pkcs12'),
        ],
        params: { certificatePassword: PASSWORD, signerName: 'Signer' },
      }),
      // Re-signing would invalidate the first signature, so it is refused.
      (error: unknown) => /already contains a digital signature/i.test((error as Error).message),
    );
  });
});

/**
 * The padding is restored by trusting DER's own declared length, and a
 * four-byte length can declare 4 GB. A 128-byte file was enough to ask for a
 * 2 GB allocation from the verify entry point — and an out-of-memory process
 * is not something a `catch` further up can put right.
 *
 * A signature that has had trailing zeros stripped is missing a handful of
 * bytes, never megabytes. So a declared length far beyond what a signature
 * could be is a corrupt or hostile file rather than a stripped one, and it is
 * left as it is to fail parsing the way it should.
 */
describe('a signature that declares an implausible length', () => {
  it('does not allocate what a four-byte length asks for', () => {
    // 30 84 7f ff ff ff — SEQUENCE, long form, 2,147,483,647 bytes of content.
    const hostile = Buffer.concat([
      Buffer.from([0x30, 0x84, 0x7f, 0xff, 0xff, 0xff]),
      Buffer.alloc(122),
    ]);

    const restored = restoreStrippedPadding(hostile);
    assert.equal(restored.length, hostile.length, 'nothing was added');
  });

  it('leaves a length just past the ceiling alone', () => {
    const tooBig = Buffer.concat([
      Buffer.from([0x30, 0x83, 0x20, 0x00, 0x01]),
      Buffer.alloc(50),
    ]);
    assert.equal(restoreStrippedPadding(tooBig).length, tooBig.length);
  });

  /** The bug it was written for still has to be fixed. */
  it('still restores a signature that really did lose its trailing zeros', () => {
    // SEQUENCE of 8 bytes, but only 6 are present: two trailing zeros gone.
    const stripped = Buffer.from([0x30, 0x08, 1, 2, 3, 4, 5, 6]);
    const restored = restoreStrippedPadding(stripped);

    assert.equal(restored.length, 10);
    assert.deepEqual([...restored.subarray(8)], [0, 0]);
  });

  it('restores a long-form length inside the ceiling', () => {
    const stripped = Buffer.concat([
      Buffer.from([0x30, 0x82, 0x01, 0x00]),
      Buffer.alloc(254),
    ]);
    assert.equal(restoreStrippedPadding(stripped).length, 4 + 256);
  });
});
