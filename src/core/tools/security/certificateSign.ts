import { webcrypto } from 'node:crypto';
import { fromBER } from 'asn1js';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { extractSignature } from '@signpdf/utils';
import {
  Certificate,
  ContentInfo,
  CryptoEngine,
  setEngine,
  SignedData,
} from 'pkijs';
import { PDFDocument } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { decryptToBytes } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor, ToolInputFile } from '../../types.ts';
import { pdfOutput, soleFile, stringParam } from '../shared.ts';

export interface CertificateSignatureInfo {
  index: number;
  cryptographicallyValid: boolean;
  /** Trust-store integration is deliberately not claimed by the local verifier. */
  certificateTrusted: false;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  error?: string;
}

interface SignatureMetadata {
  name: string;
  reason: string;
  location: string;
  contactInfo: string;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function certificateName(certificate: Certificate | undefined, field: 'subject' | 'issuer'): string {
  if (!certificate) return '';
  return certificate[field].typesAndValues
    .map((entry) => String(entry.value.valueBlock.value))
    .filter(Boolean)
    .join(', ');
}

function configureCrypto(): void {
  const crypto = webcrypto as unknown as Crypto;
  setEngine(
    'MagiesPdf WebCrypto',
    crypto,
    new CryptoEngine({ name: 'MagiesPdf WebCrypto', crypto, subtle: crypto.subtle }),
  );
}

export async function signPdfWithP12(
  pdfBytes: Uint8Array,
  p12Bytes: Uint8Array,
  passphrase: string,
  metadata: SignatureMetadata,
): Promise<Uint8Array> {
  if (Buffer.from(pdfBytes).includes('/ByteRange [')) {
    throw new ToolError(
      'INVALID_INPUT',
      'The PDF already contains a digital signature; incremental signing is required',
      {
        zh: '这个 PDF 已包含数字签名。为避免使原签名失效，MagiesPdf 不会再次签署。',
        en: 'This PDF already contains a digital signature. MagiesPdf will not re-sign it because doing so would invalidate the existing signature.',
      },
    );
  }
  const pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  pdflibAddPlaceholder({
    pdfDoc,
    reason: metadata.reason,
    contactInfo: metadata.contactInfo,
    name: metadata.name,
    location: metadata.location,
    appName: 'MagiesPdf',
  });
  const placeholder = await pdfDoc.save({ useObjectStreams: false });
  const signer = new P12Signer(Buffer.from(p12Bytes), { passphrase });
  const signed = await new SignPdf().sign(Buffer.from(placeholder), signer);
  return new Uint8Array(
    signed.buffer.slice(signed.byteOffset, signed.byteOffset + signed.byteLength),
  );
}

/**
 * Puts back the zero bytes the placeholder stripping ate.
 *
 * `/Contents` is padded with `00` to the fixed placeholder size, and
 * extracting it removes every trailing zero. When the signature's own last
 * byte is `00` — which for an RSA blob is a coin toss weighted 1 in 256, and
 * happens often enough to see — the real DER loses a byte and stops parsing.
 * A correctly signed document was then reported as having an invalid
 * signature, which is the worst direction for this feature to be wrong in.
 *
 * DER says how long it is, so the missing bytes can be counted rather than
 * guessed. Anything that is not a well-formed length is left alone, so a truly
 * malformed signature still fails as it should.
 */
export function restoreStrippedPadding(signature: Buffer): Buffer {
  if (signature.length < 2) return signature;

  const first = signature[1] ?? 0;
  let headerLength: number;
  let contentLength: number;
  if (first < 0x80) {
    headerLength = 2;
    contentLength = first;
  } else {
    const lengthBytes = first & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || signature.length < 2 + lengthBytes) return signature;
    headerLength = 2 + lengthBytes;
    contentLength = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      contentLength = contentLength * 256 + (signature[2 + index] ?? 0);
    }
  }

  const declared = headerLength + contentLength;
  if (declared <= signature.length) return signature;
  return Buffer.concat([signature, Buffer.alloc(declared - signature.length)]);
}

export async function verifyPdfSignatures(
  pdfBytes: Uint8Array,
): Promise<CertificateSignatureInfo[]> {
  configureCrypto();
  const pdf = Buffer.from(pdfBytes);
  const declaredCount = pdf.toString('latin1').split('/ByteRange [').length - 1;
  const count = Math.min(declaredCount, 32);
  const results: CertificateSignatureInfo[] = [];

  for (let index = 1; index <= count; index += 1) {
    try {
      const extracted = extractSignature(pdf, index) as {
        signature: string;
        signedData: Buffer;
      };
      const signature = restoreStrippedPadding(Buffer.from(extracted.signature, 'binary'));
      const parsed = fromBER(arrayBuffer(signature));
      if (parsed.offset === -1) throw new Error('Invalid CMS signature encoding');
      const contentInfo = new ContentInfo({ schema: parsed.result });
      const signedData = new SignedData({ schema: contentInfo.content });
      const certificate = signedData.certificates?.find(
        (entry): entry is Certificate => entry instanceof Certificate,
      );
      const cryptographicallyValid = await signedData.verify({
        signer: 0,
        data: arrayBuffer(extracted.signedData),
        checkChain: false,
      });
      results.push({
        index,
        cryptographicallyValid,
        certificateTrusted: false,
        subject: certificateName(certificate, 'subject'),
        issuer: certificateName(certificate, 'issuer'),
        validFrom: certificate?.notBefore.value.toISOString() ?? '',
        validTo: certificate?.notAfter.value.toISOString() ?? '',
      });
    } catch (cause) {
      results.push({
        index,
        cryptographicallyValid: false,
        certificateTrusted: false,
        subject: '',
        issuer: '',
        validFrom: '',
        validTo: '',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  if (declaredCount > count) {
    results.push({
      index: count + 1,
      cryptographicallyValid: false,
      certificateTrusted: false,
      subject: '',
      issuer: '',
      validFrom: '',
      validTo: '',
      error: `Signature inspection is limited to ${count} entries`,
    });
  }
  return results;
}

function certificateInput(files: ToolInputFile[]): ToolInputFile {
  const certificate = files.find((file) => /\.(p12|pfx)$/i.test(file.name));
  if (!certificate) {
    throw new ToolError('INVALID_INPUT', 'A P12 or PFX certificate is required', {
      zh: '请同时选择一个 .p12 或 .pfx 证书文件。',
      en: 'Select a .p12 or .pfx certificate file as well.',
    });
  }
  return certificate;
}

export const certificateSignTool: ToolDescriptor = {
  id: 'security.certificate-sign',
  category: 'security',
  name: { zh: '证书数字签名', en: 'Certificate Digital Signature' },
  description: {
    zh: '使用本机 P12/PFX 证书为 PDF 添加 PKCS#7 数字签名。证书和口令仅在本次任务的内存中使用。',
    en: 'Add a PKCS#7 digital signature with a local P12/PFX certificate. The certificate and password are used only in memory for this job.',
  },
  icon: 'BadgeCheck',
  keywords: ['certificate', 'p12', 'pfx', 'pkcs7', 'digital signature', '证书', '数字签名'],
  input: {
    accept: ['.pdf', '.p12', '.pfx'],
    min: 2,
    max: 2,
    ordered: true,
  },
  output: 'single',
  params: [
    {
      key: 'certificatePassword',
      type: 'password',
      label: { zh: '证书口令', en: 'Certificate password' },
      default: '',
    },
    {
      key: 'signerName',
      type: 'text',
      label: { zh: '签署人显示名称', en: 'Signer display name' },
      default: '',
      maxLength: 120,
    },
    {
      key: 'reason',
      type: 'text',
      label: { zh: '签署原因', en: 'Reason' },
      default: '',
      maxLength: 160,
    },
    {
      key: 'location',
      type: 'text',
      label: { zh: '签署地点', en: 'Location' },
      default: '',
      maxLength: 160,
      advanced: true,
    },
    {
      key: 'contactInfo',
      type: 'text',
      label: { zh: '联系方式', en: 'Contact information' },
      default: '',
      maxLength: 160,
      advanced: true,
    },
    {
      key: 'password',
      type: 'password',
      label: { zh: 'PDF 打开密码（如有）', en: 'PDF open password (if any)' },
      default: '',
      advanced: true,
    },
  ],
  runtime: 'worker',

  async run(ctx) {
    const pdfFile = soleFile({
      ...ctx,
      files: ctx.files.filter((file) => file.name.toLowerCase().endsWith('.pdf')),
    });
    const certificate = certificateInput(ctx.files);
    try {
      const source = decryptToBytes(pdfFile.bytes, stringParam(ctx, 'password'));
      const bytes = await signPdfWithP12(
        source,
        certificate.bytes,
        stringParam(ctx, 'certificatePassword'),
        {
          name: stringParam(ctx, 'signerName'),
          reason: stringParam(ctx, 'reason'),
          location: stringParam(ctx, 'location'),
          contactInfo: stringParam(ctx, 'contactInfo'),
        },
      );
      ctx.report(1);
      return {
        files: [pdfOutput(suffixedName(pdfFile.name, '_certificate_signed', '.pdf'), bytes)],
        summary: {
          zh: '已添加证书数字签名',
          en: 'Added a certificate digital signature',
        },
      };
    } catch (cause) {
      if (cause instanceof ToolError) throw cause;
      throw new ToolError(
        'INVALID_INPUT',
        `Certificate signing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          zh: '数字签名失败。请检查证书文件、证书口令和 PDF 是否有效。',
          en: 'Digital signing failed. Check the certificate file, its password, and the PDF.',
        },
      );
    }
  },
};
