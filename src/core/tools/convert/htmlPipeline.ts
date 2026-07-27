import { ToolError } from '../../errors.ts';
import type {
  HtmlToPdfOptions,
  ParamSpec,
  ToolContext,
  ToolResult,
} from '../../types.ts';
import { suffixedName } from '../../naming.ts';
import { numberParam, pdfOutput, stringParam } from '../shared.ts';

/**
 * The shared back half of every "something → HTML → PDF" tool.
 *
 * Layout is done by Chromium's print pipeline in the Electron main process
 * (`ctx.host.htmlToPdf`), which is why these tools declare `runtime: 'main'`.
 * This module owns the document shell, the common page-setup params and the
 * host plumbing so each converter only supplies body HTML.
 */

/** Print-oriented stylesheet with a CJK-aware font stack. */
const BASE_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
      "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    font-size: 11pt;
    line-height: 1.65;
    color: #1a1a1a;
    margin: 0;
    word-wrap: break-word;
  }
  h1, h2, h3, h4 { line-height: 1.3; margin: 1.2em 0 0.5em; page-break-after: avoid; }
  h1 { font-size: 1.8em; } h2 { font-size: 1.4em; } h3 { font-size: 1.15em; }
  p { margin: 0.6em 0; }
  pre, code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace;
    font-size: 0.9em;
  }
  pre {
    background: #f6f6f4;
    border: 1pt solid #e2e2de;
    border-radius: 4pt;
    padding: 8pt;
    overflow-x: hidden;
    white-space: pre-wrap;
    page-break-inside: avoid;
  }
  code { background: #f2f2ef; padding: 0 3pt; border-radius: 2pt; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0.8em 0; padding: 0.1em 1em; border-left: 3pt solid #d0d0cc; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 0.8em 0; page-break-inside: avoid; }
  th, td { border: 1pt solid #ccc; padding: 4pt 8pt; text-align: left; }
  th { background: #f4f4f2; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1pt solid #ddd; margin: 1.5em 0; }
  a { color: #2451b3; text-decoration: none; }
`;

/** Wraps body HTML in a complete printable document. */
export function wrapHtmlDocument(bodyHtml: string, title: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${BASE_CSS}</style>`,
    '</head>',
    `<body>${bodyHtml}</body>`,
    '</html>',
  ].join('\n');
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Page-setup params shared by every HTML-based converter. */
export function pageSetupParams(): ParamSpec[] {
  return [
    {
      key: 'pageSize',
      type: 'select',
      label: { zh: '纸型', en: 'Page size' },
      default: 'A4',
      options: [
        { value: 'A4', label: { zh: 'A4', en: 'A4' } },
        { value: 'A3', label: { zh: 'A3', en: 'A3' } },
        { value: 'A5', label: { zh: 'A5', en: 'A5' } },
        { value: 'Letter', label: { zh: 'Letter', en: 'Letter' } },
        { value: 'Legal', label: { zh: 'Legal', en: 'Legal' } },
      ],
    },
    {
      key: 'landscape',
      type: 'boolean',
      label: { zh: '横向', en: 'Landscape' },
      default: false,
    },
    {
      key: 'marginInches',
      type: 'number',
      label: { zh: '页边距', en: 'Margins' },
      unit: { zh: '英寸', en: 'in' },
      default: 0.6,
      min: 0,
      max: 2,
      step: 0.1,
      advanced: true,
    },
  ];
}

export function pageSetupOf(ctx: ToolContext): HtmlToPdfOptions {
  const margin = numberParam(ctx, 'marginInches');
  return {
    pageSize: stringParam(ctx, 'pageSize') as HtmlToPdfOptions['pageSize'],
    landscape: ctx.params.landscape === true,
    margins: { top: margin, bottom: margin, left: margin, right: margin },
    printBackground: true,
  };
}

/** Renders wrapped HTML through the host and packages the standard result. */
export async function htmlThroughHost(
  ctx: ToolContext,
  bodyHtml: string,
  sourceName: string,
  summary: { zh: string; en: string },
): Promise<ToolResult> {
  if (!ctx.host) {
    throw new ToolError('HOST_UNAVAILABLE', 'HTML conversion requires the main-process host', {
      zh: '此转换需要应用主进程能力，无法在当前环境运行。',
      en: 'This conversion needs main-process capabilities and cannot run here.',
    });
  }

  const html = wrapHtmlDocument(bodyHtml, sourceName);
  const bytes = await ctx.host.htmlToPdf(html, pageSetupOf(ctx), ctx.signal);
  ctx.report(1);

  return {
    files: [pdfOutput(suffixedName(sourceName, '', '.pdf'), bytes)],
    summary,
  };
}
