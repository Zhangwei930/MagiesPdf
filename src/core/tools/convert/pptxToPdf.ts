import { ToolError } from '../../errors.ts';
import { extractPptxSlideTexts } from '../../ooxml/pptx.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { escapeHtml, htmlThroughHost, pageSetupParams } from './htmlPipeline.ts';
import { pdfOutput, soleFile } from '../shared.ts';

/** Slide texts → printable HTML. Exported for host-free tests. */
export function slidesToHtml(slides: readonly string[]): string {
  if (slides.length === 0) return '<p></p>';
  return slides
    .map((text, index) => {
      const body =
        text === ''
          ? '<p class="empty"> </p>'
          : text
              .split(/\n+/)
              .map((line) => `<p>${escapeHtml(line)}</p>`)
              .join('\n');
      return `<section class="slide" data-slide="${index + 1}"><h2>Slide ${index + 1}</h2>\n${body}</section>`;
    })
    .join('\n<hr class="slide-break"/>\n');
}

export const pptxToPdfTool: ToolDescriptor = {
  id: 'convert.pptx-to-pdf',
  category: 'convert',
  name: { zh: 'PPT 转 PDF', en: 'PowerPoint to PDF' },
  description: {
    zh: '把 .pptx 演示文稿转成 PDF。检测到 LibreOffice 时自动使用本地办公引擎保留版式。',
    en: 'Convert a .pptx presentation to PDF. Automatically uses the local LibreOffice engine to preserve layout when available.',
  },
  icon: 'GalleryVertical',
  keywords: ['powerpoint', 'pptx', 'slides', 'presentation', '演示', '幻灯片', '转换'],
  input: { accept: ['.pptx'], min: 1, max: 1 },
  output: 'single',
  params: pageSetupParams(),
  runtime: 'main',

  async run(ctx) {
    const file = soleFile(ctx);

    if (ctx.host?.hasExternalConverter('pdf')) {
      const output = await ctx.host.externalConvert(file, 'pdf', ctx.signal);
      ctx.report(1);
      return {
        files: [pdfOutput(suffixedName(file.name, '', '.pdf'), output.bytes)],
        summary: {
          zh: `已通过本地办公引擎转换「${file.name}」`,
          en: `Converted "${file.name}" via the local Office engine`,
        },
      };
    }

    let slides: string[];
    try {
      slides = extractPptxSlideTexts(file.bytes);
    } catch (cause) {
      throw new ToolError(
        'CORRUPT_DOCUMENT',
        `pptx parse failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          zh: '无法解析这个 PowerPoint 文件——文件可能已损坏，或是老式 .ppt 格式。',
          en: 'This presentation could not be parsed — it may be damaged, or a legacy .ppt file.',
        },
      );
    }

    if (slides.length === 0) {
      throw new ToolError('EMPTY_RESULT', 'Presentation has no slides', {
        zh: '这个演示文稿里没有幻灯片。',
        en: 'This presentation has no slides.',
      });
    }

    return htmlThroughHost(ctx, slidesToHtml(slides), file.name, {
      zh: `已转换「${file.name}」（${slides.length} 页）`,
      en: `Converted "${file.name}" (${slides.length} slide(s))`,
    });
  },
};
