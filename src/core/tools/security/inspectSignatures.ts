import { openDocument } from '../../pdf/document.ts';
import type { ToolDescriptor } from '../../types.ts';
import type { ReportRow } from '../edit/getInfo.ts';
import { PDF_ONE, passwordParam, soleFile, stringParam } from '../shared.ts';

/**
 * Inventory interactive signature widgets (AcroForm `/Sig` fields).
 *
 * This does not cryptographically validate PKCS#7 payloads — MuPDF's JS build
 * does not expose that. It answers "does this PDF claim to have signature
 * fields, and what are their names/values?" which is still useful before
 * trusting a document.
 */
export const inspectSignaturesTool: ToolDescriptor = {
  id: 'security.inspect-signatures',
  category: 'security',
  name: { zh: '检查签名域', en: 'Inspect Signature Fields' },
  description: {
    zh: '列出文档中的签名表单域（若有）。不验证数字证书真伪，只做结构检查。',
    en: 'List signature form fields, if any. Structural only — does not validate certificates.',
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
            : 'Field inventory only — cryptographic certificate validation is not performed.',
      });

      ctx.report(1);
      return {
        files: [],
        data: rows,
        summary: {
          zh:
            sigCount > 0
              ? `发现 ${sigCount} 个签名域（未做证书校验）`
              : '未发现签名表单域',
          en:
            sigCount > 0
              ? `Found ${sigCount} signature field(s) (not cryptographically verified)`
              : 'No signature form fields found',
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
