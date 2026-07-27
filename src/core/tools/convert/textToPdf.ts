import type { ToolDescriptor } from '../../types.ts';
import { escapeHtml, htmlThroughHost, pageSetupParams } from './htmlPipeline.ts';
import { soleFile } from '../shared.ts';

export const textToPdfTool: ToolDescriptor = {
  id: 'convert.text-to-pdf',
  category: 'convert',
  name: { zh: '文本转 PDF', en: 'Text to PDF' },
  description: {
    zh: '把纯文本排版成 PDF，保留换行，适合日志、代码片段和说明文件。',
    en: 'Typeset plain text into a PDF, preserving line breaks — logs, snippets, notes.',
  },
  icon: 'FileText',
  keywords: ['text', 'txt', 'plain', 'log', '文本', '纯文本', '日志'],
  input: { accept: ['.txt', '.log', '.text'], min: 1, max: 1 },
  output: 'single',
  params: pageSetupParams(),
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);
    const text = new TextDecoder().decode(file.bytes);
    const body = `<pre>${escapeHtml(text)}</pre>`;

    return htmlThroughHost(ctx, body, file.name, {
      zh: `已把「${file.name}」排版为 PDF`,
      en: `Typeset "${file.name}" as PDF`,
    });
  },
};
