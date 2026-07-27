import type * as mupdf from 'mupdf';
import { openDocument } from '../../pdf/document.ts';
import { PERMISSIONS } from '../../pdf/permissions.ts';
import type { LocalizedText, ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, soleFile, stringParam } from '../shared.ts';

/**
 * The convention for report-tool payloads: a flat list of labelled rows the UI
 * renders as a table. Anything else in `data` falls back to raw JSON display.
 */
export interface ReportRow {
  label: LocalizedText;
  value: string;
}

const METADATA_FIELDS: Array<{ key: string; label: LocalizedText }> = [
  { key: 'info:Title', label: { zh: '标题', en: 'Title' } },
  { key: 'info:Author', label: { zh: '作者', en: 'Author' } },
  { key: 'info:Subject', label: { zh: '主题', en: 'Subject' } },
  { key: 'info:Keywords', label: { zh: '关键词', en: 'Keywords' } },
  { key: 'info:Creator', label: { zh: '创建程序', en: 'Creator' } },
  { key: 'info:Producer', label: { zh: '生成器', en: 'Producer' } },
  { key: 'info:CreationDate', label: { zh: '创建时间', en: 'Created' } },
  { key: 'info:ModDate', label: { zh: '修改时间', en: 'Modified' } },
];

/** `D:20260727140256Z` → `2026-07-27 14:02:56Z`; anything unparseable passes through. */
export function formatPdfDate(raw: string): string {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw);
  if (!match) return raw;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = match;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/** Groups identical page sizes: `595 × 842 pt` or `595 × 842 pt × 3, 842 × 595 pt × 1`. */
export function summarizePageSizes(doc: mupdf.PDFDocument): string {
  const counts = new Map<string, number>();
  const pageCount = doc.countPages();
  for (let i = 0; i < pageCount; i += 1) {
    const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
    const key = `${Math.round(x1 - x0)} × ${Math.round(y1 - y0)} pt`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([size, n]) => (counts.size === 1 ? size : `${size} × ${n}`))
    .join(', ');
}

export const getInfoTool: ToolDescriptor = {
  id: 'edit.get-info',
  category: 'edit',
  name: { zh: '文档信息', en: 'Document Info' },
  description: {
    zh: '查看页数、页面尺寸、元数据、加密与权限状态。',
    en: 'Inspect page count, page sizes, metadata, encryption and permissions.',
  },
  icon: 'Info',
  keywords: ['info', 'metadata', 'properties', 'inspect', '信息', '属性', '元数据', '查看'],
  input: PDF_ONE,
  output: 'report',
  params: [passwordParam()],
  runtime: 'worker',
  pipelineable: false,

  async run(ctx) {
    const file = soleFile(ctx);

    // Peek at encryption before authenticating, since authentication hides it.
    let encrypted = false;
    try {
      const peek = openDocument(file.bytes, stringParam(ctx, 'password'));
      encrypted = peek.getMetaData('encryption') !== 'None';
      peek.destroy();
    } catch {
      encrypted = true;
    }

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const rows: ReportRow[] = [
        { label: { zh: '文件名', en: 'File name' }, value: file.name },
        {
          label: { zh: '文件大小', en: 'File size' },
          value:
            file.bytes.length >= 1024 * 1024
              ? `${(file.bytes.length / 1024 / 1024).toFixed(2)} MB`
              : `${Math.round(file.bytes.length / 1024)} KB`,
        },
        { label: { zh: '格式版本', en: 'Format' }, value: doc.getMetaData('format') ?? '—' },
        { label: { zh: '页数', en: 'Pages' }, value: String(doc.countPages()) },
        { label: { zh: '页面尺寸', en: 'Page sizes' }, value: summarizePageSizes(doc) },
        {
          label: { zh: '加密', en: 'Encryption' },
          value: encrypted
            ? (doc.getMetaData('encryption') ?? '').replace('None', '') || 'Encrypted'
            : '—',
        },
      ];

      if (encrypted) {
        // Our permission keys vs. MuPDF's probe names.
        const PROBE_NAMES: Record<string, string> = {
          print: 'print',
          modify: 'edit',
          copy: 'copy',
          annotate: 'annotate',
          fillForms: 'form',
          accessibility: 'accessibility',
          assemble: 'assemble',
        };
        const denied = PERMISSIONS.filter(
          (p) => !doc.hasPermission((PROBE_NAMES[p.key] ?? p.key) as never),
        ).map((p) => `${p.label.zh} / ${p.label.en}`);
        rows.push({
          label: { zh: '受限操作', en: 'Restricted actions' },
          value: denied.length > 0 ? denied.join('；') : '—',
        });
      }

      const outline = doc.loadOutline();
      rows.push({
        label: { zh: '书签目录', en: 'Outline' },
        value: outline && outline.length > 0
          ? `${outline.length} ${outline.length === 1 ? 'entry' : 'entries'}`
          : '—',
      });

      for (const field of METADATA_FIELDS) {
        const raw = doc.getMetaData(field.key);
        if (raw === undefined || raw === '') continue;
        rows.push({
          label: field.label,
          value: field.key.endsWith('Date') ? formatPdfDate(raw) : raw,
        });
      }

      ctx.report(1);
      return {
        files: [],
        data: rows,
        summary: {
          zh: `${doc.countPages()} 页 · ${doc.getMetaData('format') ?? 'PDF'} · ${encrypted ? '已加密' : '未加密'}`,
          en: `${doc.countPages()} pages · ${doc.getMetaData('format') ?? 'PDF'} · ${encrypted ? 'encrypted' : 'not encrypted'}`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
