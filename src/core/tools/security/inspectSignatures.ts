import { openDocument } from '../../pdf/document.ts';
import type { ToolDescriptor } from '../../types.ts';
import type { ReportRow } from '../edit/getInfo.ts';
import { PDF_ONE, passwordParam, soleFile, stringParam } from '../shared.ts';
import { verifyPdfSignatures } from './certificateSign.ts';

/**
 * Inventory interactive signature widgets (AcroForm `/Sig` fields).
 *
 * Lists signature widgets and verifies PKCS#7 integrity over each declared
 * ByteRange. Certificate trust and revocation are intentionally reported as
 * unevaluated because this tool does not use the operating-system trust store.
 */
export const inspectSignaturesTool: ToolDescriptor = {
  id: 'security.inspect-signatures',
  category: 'security',
  name: { zh: '检查签名域', en: 'Inspect Signature Fields' },
  description: {
    zh: '列出签名域并检查数字签名覆盖内容是否被篡改；不判断证书是否受系统信任或已吊销。',
    en: 'List signature fields and check signed-byte integrity; OS certificate trust and revocation are not evaluated.',
  },
  icon: 'ShieldCheck',
  keywords: [
    'signature',
    'digital signature',
    'certificate',
    'pkcs',
    'verify',
    '签名',
    '数字签名',
    '证书',
    '验签',
  ],
  input: PDF_ONE,
  output: 'report',
  pipelineable: false,
  params: [passwordParam()],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));

    try {
      const rows: ReportRow[] = [];
      let sigCount = 0;
      let otherWidgets = 0;
      const pageCount = doc.countPages();

      for (let i = 0; i < pageCount; i += 1) {
        for (const widget of doc.loadPage(i).getWidgets()) {
          const type = (widget.getFieldType() || 'unknown').toLowerCase();
          const name = widget.getName() || `(unnamed p${i + 1})`;
          if (type === 'sig' || type === 'signature') {
            sigCount += 1;
            const value = String(widget.getValue() ?? '');
            rows.push({
              label: { zh: `签名域 · 第 ${i + 1} 页`, en: `Signature · page ${i + 1}` },
              value: value
                ? `${name} (${type}) — ${value.slice(0, 80)}`
                : `${name} (${type}) — empty / not signed`,
            });
          } else {
            otherWidgets += 1;
          }
        }
      }

      const verified = await verifyPdfSignatures(file.bytes);
      for (const signature of verified) {
        rows.push({
          label: {
            zh: `密码学完整性 · 签名 ${signature.index}`,
            en: `Cryptographic integrity · signature ${signature.index}`,
          },
          value: signature.cryptographicallyValid
            ? 'Valid (certificate trust not evaluated)'
            : `Invalid${signature.error ? ` — ${signature.error}` : ''}`,
        });
        if (signature.subject) {
          rows.push({
            label: {
              zh: `证书主体 · 签名 ${signature.index}`,
              en: `Certificate subject · signature ${signature.index}`,
            },
            value: signature.subject,
          });
        }
        if (signature.issuer) {
          rows.push({
            label: {
              zh: `证书签发者 · 签名 ${signature.index}`,
              en: `Certificate issuer · signature ${signature.index}`,
            },
            value: signature.issuer,
          });
        }
      }

      rows.unshift({
        label: { zh: '签名域数量', en: 'Signature fields' },
        value: String(sigCount),
      });
      rows.push({
        label: { zh: '其他表单域', en: 'Other form widgets' },
        value: String(otherWidgets),
      });
      rows.push({
        label: { zh: '说明', en: 'Note' },
        value:
          sigCount === 0
            ? 'No AcroForm signature fields found. Visible ink stamps are not listed here.'
            : 'Integrity is checked cryptographically. Certificate trust/revocation is not evaluated against the operating-system trust store.',
      });

      ctx.report(1);
      return {
        files: [],
        data: rows,
        summary: {
          zh:
            sigCount > 0
              ? `发现 ${sigCount} 个签名域，已检查 ${verified.length} 个数字签名的完整性`
              : '未发现签名表单域',
          en:
            sigCount > 0
              ? `Found ${sigCount} signature field(s); checked ${verified.length} digital signature(s) for integrity`
              : 'No signature form fields found',
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
