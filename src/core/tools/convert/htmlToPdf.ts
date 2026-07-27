import { ToolError } from '../../errors.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { pageSetupOf, pageSetupParams } from './htmlPipeline.ts';
import { pdfOutput, soleFile } from '../shared.ts';

export const htmlToPdfTool: ToolDescriptor = {
  id: 'convert.html-to-pdf',
  category: 'convert',
  name: { zh: 'HTML 转 PDF', en: 'HTML to PDF' },
  description: {
    zh: '用浏览器同款排版引擎把 HTML 文件打印成 PDF。',
    en: 'Print an HTML file to PDF with the same layout engine a browser uses.',
  },
  icon: 'Globe',
  keywords: ['html', 'web', 'page', 'print', '网页', '打印'],
  input: { accept: ['.html', '.htm'], min: 1, max: 1 },
  output: 'single',
  params: pageSetupParams(),
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);
    if (!ctx.host) {
      throw new ToolError('HOST_UNAVAILABLE', 'HTML conversion requires the main-process host', {
        zh: '此转换需要应用主进程能力，无法在当前环境运行。',
        en: 'This conversion needs main-process capabilities and cannot run here.',
      });
    }

    // The user's HTML is rendered as-is — their own styles, not our shell.
    const html = new TextDecoder().decode(file.bytes);
    const bytes = await ctx.host.htmlToPdf(html, pageSetupOf(ctx));
    ctx.report(1);

    return {
      files: [pdfOutput(suffixedName(file.name, '', '.pdf'), bytes)],
      summary: {
        zh: `已把「${file.name}」打印为 PDF`,
        en: `Printed "${file.name}" to PDF`,
      },
    };
  },
};
