import { ToolError } from '../../errors.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { htmlThroughHost, pageSetupParams } from './htmlPipeline.ts';
import { pdfOutput, soleFile } from '../shared.ts';

/** docx body → HTML via mammoth. Exported for direct testing without a host. */
export async function docxToHtml(bytes: Uint8Array): Promise<{ html: string; warnings: string[] }> {
  const mammoth = await import('mammoth');
  try {
    const result = await mammoth.convertToHtml({
      buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
    return {
      html: result.value,
      warnings: result.messages.map((message) => message.message),
    };
  } catch (cause) {
    throw new ToolError(
      'CORRUPT_DOCUMENT',
      `mammoth failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        zh: '无法解析这个 Word 文档——文件可能已损坏，或是老式 .doc 格式（请先在 Word 里另存为 .docx）。',
        en: 'This Word document could not be parsed — it may be damaged, or a legacy .doc (re-save it as .docx first).',
      },
    );
  }
}

export const docxToPdfTool: ToolDescriptor = {
  id: 'convert.docx-to-pdf',
  category: 'convert',
  name: { zh: 'Word 转 PDF', en: 'Word to PDF' },
  description: {
    zh: '把 .docx 文档转成 PDF。保留标题、表格、图片等内容结构；如在设置里配置了外部转换器，则优先用它获得更高版式保真度。',
    en: 'Convert .docx to PDF. Headings, tables and images survive; when an external converter is configured in Settings, it is preferred for higher layout fidelity.',
  },
  icon: 'FileText',
  keywords: ['word', 'docx', 'document', 'office', '文档', '转换'],
  input: { accept: ['.docx'], min: 1, max: 1 },
  output: 'single',
  params: pageSetupParams(),
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);

    // The user-configured external converter, when present, produces the most
    // faithful layout — the built-in path is the always-available fallback.
    if (ctx.host?.hasExternalConverter()) {
      const output = await ctx.host.externalConvert(file, 'pdf');
      ctx.report(1);
      return {
        files: [pdfOutput(suffixedName(file.name, '', '.pdf'), output.bytes)],
        summary: {
          zh: `已通过外部转换器转换「${file.name}」`,
          en: `Converted "${file.name}" via the external converter`,
        },
      };
    }

    const { html, warnings } = await docxToHtml(file.bytes);
    return htmlThroughHost(ctx, html, file.name, {
      zh:
        warnings.length > 0
          ? `已转换「${file.name}」（${warnings.length} 处内容有简化）`
          : `已转换「${file.name}」`,
      en:
        warnings.length > 0
          ? `Converted "${file.name}" (${warnings.length} elements simplified)`
          : `Converted "${file.name}"`,
    });
  },
};
