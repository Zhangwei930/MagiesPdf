import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import forge from 'node-forge';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import type { ReportRow } from '../edit/getInfo.ts';
import { signPdfWithP12, verifyPdfSignatures } from './certificateSign.ts';
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
