import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import forge from 'node-forge';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import type { ReportRow } from '../edit/getInfo.ts';
import { restoreStrippedPadding, signPdfWithP12, verifyPdfSignatures } from './certificateSign.ts';
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
