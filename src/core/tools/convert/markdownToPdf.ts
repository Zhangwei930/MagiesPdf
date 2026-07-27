import { marked } from 'marked';
import type { ToolDescriptor } from '../../types.ts';
import { htmlThroughHost, pageSetupParams } from './htmlPipeline.ts';
import { soleFile } from '../shared.ts';

export const markdownToPdfTool: ToolDescriptor = {
  id: 'convert.markdown-to-pdf',
  category: 'convert',
  name: { zh: 'Markdown 转 PDF', en: 'Markdown to PDF' },
  description: {
    zh: '把 Markdown 笔记排版成干净的 PDF，代码块、表格、中文都处理好。',
    en: 'Typeset Markdown into a clean PDF — code blocks, tables and CJK all handled.',
  },
  icon: 'FileCode',
  keywords: ['markdown', 'md', 'notes', 'render', '笔记', '排版', '转换'],
  input: { accept: ['.md', '.markdown', '.txt'], min: 1, max: 1 },
  output: 'single',
  params: pageSetupParams(),
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);
    const markdown = new TextDecoder().decode(file.bytes);
    const body = await marked.parse(markdown, { async: true, gfm: true, breaks: false });

    return htmlThroughHost(ctx, body, file.name, {
      zh: `已把「${file.name}」排版为 PDF`,
      en: `Typeset "${file.name}" as PDF`,
    });
  },
};
