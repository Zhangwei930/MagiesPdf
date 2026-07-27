import { withDocumentSync } from '../../pdf/document.ts';
import type { ToolDescriptor } from '../../types.ts';
import type { ReportRow } from '../edit/getInfo.ts';
import { PDF_ONE, passwordParam, soleFile, stringParam } from '../shared.ts';
import { collectJavaScript } from './sanitize.ts';

const SOURCE_PREVIEW_LIMIT = 600;

export const showJavascriptTool: ToolDescriptor = {
  id: 'security.show-javascript',
  category: 'security',
  name: { zh: '查看脚本', en: 'Show JavaScript' },
  description: {
    zh: '列出文档里藏着的所有 JavaScript 及其位置——打开可疑文件前先看一眼。',
    en: 'List every JavaScript the document carries, and where — look before you open something dubious.',
  },
  icon: 'FileSearch',
  keywords: ['javascript', 'script', 'inspect', 'audit', '脚本', '检查', '审计', '查看'],
  input: PDF_ONE,
  output: 'report',
  params: [passwordParam()],
  runtime: 'worker',
  pipelineable: false,

  async run(ctx) {
    const file = soleFile(ctx);

    return withDocumentSync(file.bytes, stringParam(ctx, 'password'), (doc) => {
      const scripts = collectJavaScript(doc);
      ctx.report(1);

      if (scripts.length === 0) {
        return {
          files: [],
          data: [
            {
              label: { zh: '检查结果', en: 'Result' },
              value: '✓',
            },
          ] satisfies ReportRow[],
          summary: {
            zh: '未发现任何 JavaScript',
            en: 'No JavaScript found',
          },
        };
      }

      const rows: ReportRow[] = scripts.map((script, index) => ({
        label: {
          zh: `脚本 ${index + 1}（${script.location}）`,
          en: `Script ${index + 1} (${script.location})`,
        },
        value:
          script.source.length > SOURCE_PREVIEW_LIMIT
            ? `${script.source.slice(0, SOURCE_PREVIEW_LIMIT)}…`
            : script.source || '(empty)',
      }));

      return {
        files: [],
        data: rows,
        summary: {
          zh: `发现 ${scripts.length} 段 JavaScript——可用「净化文档」移除`,
          en: `Found ${scripts.length} scripts — the Sanitise tool can remove them`,
        },
      };
    });
  },
};
