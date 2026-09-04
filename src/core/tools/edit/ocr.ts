import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { stampInvisibleWords, type InvisibleWord } from '../../pdf/overlay.ts';
import { renderPage } from '../../pdf/render.ts';
import { stemOf, suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  checkCancelled,
  listParam,
  numberParam,
  pageRangeParam,
  passwordParam,
  pdfOutput,
  reportStep,
  resolvePages,
  soleFile,
  stringParam,
} from '../shared.ts';

/**
 * OCR via tesseract.js.
 *
 * Language models are cached under the user's home directory after a one-time
 * download — the only network access this tool ever makes, and the document
 * itself never leaves the machine. Once cached, OCR runs fully offline.
 */

/**
 * Where a downloaded language model is kept. Exported so a caller can tell a
 * run that will use the network apart from one that will not — the first is
 * subject to whatever the network is doing, and the second is not.
 */
export const LANGUAGE_CACHE = path.join(os.homedir(), '.magiespdf', 'tessdata');

export const OCR_LANGUAGES = [
  { value: 'chi_sim', label: { zh: '简体中文', en: 'Chinese (Simplified)' } },
  { value: 'chi_tra', label: { zh: '繁体中文', en: 'Chinese (Traditional)' } },
  { value: 'eng', label: { zh: '英语', en: 'English' } },
  { value: 'jpn', label: { zh: '日语', en: 'Japanese' } },
  { value: 'kor', label: { zh: '韩语', en: 'Korean' } },
  { value: 'fra', label: { zh: '法语', en: 'French' } },
  { value: 'deu', label: { zh: '德语', en: 'German' } },
  { value: 'spa', label: { zh: '西班牙语', en: 'Spanish' } },
  { value: 'rus', label: { zh: '俄语', en: 'Russian' } },
] as const;

export function assertOcrModelConsent(
  languages: readonly string[],
  allowModelDownload: boolean,
  cachePath = LANGUAGE_CACHE,
): void {
  const missing = languages.filter(
    (language) => !fs.existsSync(path.join(cachePath, `${language}.traineddata`)),
  );
  if (missing.length > 0 && !allowModelDownload) {
    throw new ToolError(
      'NETWORK_CONSENT_REQUIRED',
      `OCR language model download needs consent: ${missing.join(', ')}`,
      {
        zh: `尚未缓存识别模型：${missing.join('、')}。如同意从 jsDelivr 下载模型，请勾选“允许下载缺失模型”。文档本身不会上传。`,
        en: `OCR models are not cached: ${missing.join(', ')}. Enable “Allow missing model downloads” to fetch them from jsDelivr. Your document is not uploaded.`,
      },
      { missingLanguages: missing },
    );
  }
}

interface RecognizedWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface RecognizedPage {
  text: string;
  words: RecognizedWord[];
}

type TesseractWorker = {
  recognize(
    image: Buffer,
    opts: Record<string, unknown>,
    output: Record<string, boolean>,
  ): Promise<{
    data: {
      text: string;
      blocks:
        | Array<{
            paragraphs: Array<{
              lines: Array<{ words: Array<RecognizedWord> }>;
            }>;
          }>
        | null;
    };
  }>;
  terminate(): Promise<unknown>;
};

async function createOcrWorker(languages: string[]): Promise<TesseractWorker> {
  fs.mkdirSync(LANGUAGE_CACHE, { recursive: true });

  const { createWorker } = await import('tesseract.js');
  try {
    return (await createWorker(languages, 1, {
      cachePath: LANGUAGE_CACHE,
      // No progress logger: tesseract.js's default logger writes to stdout,
      // which is our worker's structured message channel in spirit.
      logger: () => {},
    })) as unknown as TesseractWorker;
  } catch (cause) {
    throw new ToolError(
      'INTERNAL',
      `Failed to initialise OCR: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        zh: 'OCR 引擎初始化失败。首次使用某种语言时需要联网下载识别模型（约几 MB，仅一次）；请检查网络后重试。文档本身不会被上传。',
        en: 'The OCR engine failed to start. The first use of a language downloads its model (a few MB, once) — check your connection and retry. Your document is never uploaded.',
      },
    );
  }
}

export async function recognizePage(
  worker: TesseractWorker,
  png: Uint8Array,
): Promise<RecognizedPage> {
  const { data } = await worker.recognize(Buffer.from(png), {}, { text: true, blocks: true });
  const words = (data.blocks ?? [])
    .flatMap((block) => block.paragraphs)
    .flatMap((paragraph) => paragraph.lines)
    .flatMap((line) => line.words)
    .filter((word) => word.text.trim() !== '');
  return { text: data.text, words };
}

export const ocrTool: ToolDescriptor = {
  id: 'edit.ocr',
  category: 'edit',
  name: { zh: 'OCR 文字识别', en: 'OCR' },
  description: {
    zh: '识别扫描件里的文字，生成可搜索、可复制的 PDF，或导出纯文本。',
    en: 'Recognise text in scans — produce a searchable, copyable PDF, or plain text.',
  },
  icon: 'ScanText',
  keywords: ['ocr', 'recognize', 'scan', 'searchable', 'text', '识别', '扫描件', '可搜索', '文字'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'languages',
      type: 'multiselect',
      label: { zh: '识别语言', en: 'Languages' },
      help: {
        zh: '选中文档里出现的语言。首次使用会下载对应识别模型（约几 MB，此后离线可用）。',
        en: 'Pick the languages present in the document. First use downloads each model (a few MB); afterwards OCR is fully offline.',
      },
      default: ['chi_sim', 'eng'],
      options: OCR_LANGUAGES.map((l) => ({ value: l.value, label: l.label })),
      minSelected: 1,
    },
    {
      key: 'allowModelDownload',
      type: 'boolean',
      label: { zh: '允许下载缺失模型', en: 'Allow missing model downloads' },
      help: {
        zh: '仅在所选语言模型尚未缓存时访问 jsDelivr；不会上传文档。',
        en: 'Uses jsDelivr only when a selected model is not cached; the document is never uploaded.',
      },
      default: false,
    },
    {
      key: 'output',
      type: 'select',
      label: { zh: '输出', en: 'Output' },
      default: 'searchable',
      options: [
        {
          value: 'searchable',
          label: { zh: '可搜索 PDF（原样 + 隐形文字层）', en: 'Searchable PDF (original + invisible text layer)' },
        },
        { value: 'text', label: { zh: '纯文本 .txt', en: 'Plain text .txt' } },
      ],
    },
    {
      key: 'dpi',
      type: 'number',
      label: { zh: '识别分辨率', en: 'Recognition resolution' },
      unit: { zh: 'DPI', en: 'DPI' },
      help: {
        zh: '300 是识别率与速度的均衡点；小字体可尝试 400。',
        en: '300 balances accuracy and speed; try 400 for small print.',
      },
      default: 300,
      min: 150,
      max: 600,
      integer: true,
      advanced: true,
    },
    pageRangeParam({ label: { zh: '识别哪些页', en: 'Pages to recognise' } }),
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const languages = listParam(ctx, 'languages');
    assertOcrModelConsent(languages, ctx.params.allowModelDownload === true);
    const outputKind = stringParam(ctx, 'output');
    const dpi = numberParam(ctx, 'dpi');
    /** Rendered pixels back to PDF points. */
    const toPt = 72 / dpi;

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    const worker = await createOcrWorker(languages);
    try {
      const pages = resolvePages(ctx, 'pages', doc.countPages());
      const pageTexts: string[] = [];

      for (const [index, page] of pages.entries()) {
        checkCancelled(ctx);
        reportStep(ctx, index, pages.length, {
          zh: `正在识别第 ${page} 页（${index + 1}/${pages.length}）`,
          en: `Recognising page ${page} (${index + 1} of ${pages.length})`,
        });

        const rendered = renderPage(doc, page - 1, { dpi, format: 'png' });
        const recognized = await recognizePage(worker, rendered.bytes);
        pageTexts.push(recognized.text.trim());

        if (outputKind === 'searchable') {
          const [, , , pageY1] = doc.loadPage(page - 1).getBounds();
          const words: InvisibleWord[] = recognized.words.map((word) => ({
            text: word.text,
            x: word.bbox.x0 * toPt,
            // Image origin is top-left; PDF's is bottom-left. The word's baseline
            // sits near the bottom of its box.
            y: pageY1 - word.bbox.y1 * toPt,
            size: Math.max(1, (word.bbox.y1 - word.bbox.y0) * toPt),
            targetWidth: Math.max(0.5, (word.bbox.x1 - word.bbox.x0) * toPt),
          }));
          stampInvisibleWords(doc, page - 1, words);
        }
      }

      ctx.report(1);
      const characters = pageTexts.join('').replace(/\s/g, '').length;

      if (outputKind === 'text') {
        return {
          files: [
            {
              name: `${stemOf(file.name)}.txt`,
              bytes: new TextEncoder().encode(pageTexts.join('\n\n')),
              mime: 'text/plain',
            },
          ],
          summary: {
            zh: `已从 ${pages.length} 页识别出 ${characters} 个字符`,
            en: `Recognised ${characters} characters across ${pages.length} pages`,
          },
        };
      }

      const bytes = saveDocument(doc, { garbage: 'compact' });
      return {
        files: [pdfOutput(suffixedName(file.name, '_ocr', '.pdf'), bytes)],
        summary: {
          zh: `已为 ${pages.length} 页加上可搜索文字层（${characters} 个字符）`,
          en: `Added a searchable text layer to ${pages.length} pages (${characters} characters)`,
        },
      };
    } finally {
      await worker.terminate().catch(() => {});
      doc.destroy();
    }
  },
};
