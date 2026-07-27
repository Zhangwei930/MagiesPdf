import type * as mupdf from 'mupdf';
import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import type { ReportRow } from './getInfo.ts';
import { PDF_ONE, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

/**
 * Parse `name=value` lines (one field per line). Lines starting with `#` are
 * comments; blank lines are ignored. The first `=` separates name from value so
 * values may contain `=`.
 */
export function parseFieldMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new ToolError('INVALID_PARAM', `Field line must be name=value, got: ${line}`, {
        zh: `表单行格式应为 字段名=值，无法解析：${line}`,
        en: `Each field line must be name=value; could not parse: ${line}`,
      });
    }
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return map;
}

export interface FormFieldInfo {
  name: string;
  type: string;
  value: string;
  readOnly: boolean;
}

/** Collect every unique field name across all pages. */
export function listFormFields(doc: mupdf.PDFDocument): FormFieldInfo[] {
  const byName = new Map<string, FormFieldInfo>();
  const pageCount = doc.countPages();

  for (let i = 0; i < pageCount; i += 1) {
    for (const widget of doc.loadPage(i).getWidgets()) {
      const name = widget.getName() || `(unnamed-${i})`;
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        type: widget.getFieldType() || 'unknown',
        value: String(widget.getValue() ?? ''),
        readOnly: widget.isReadOnly(),
      });
    }
  }

  return [...byName.values()];
}

function isTruthy(value: string): boolean {
  return /^(1|true|yes|on|y|是|选中)$/i.test(value.trim());
}

function isWidgetOn(widget: mupdf.PDFWidget): boolean {
  const current = String(widget.getValue() ?? '');
  return current !== '' && current !== 'Off';
}

function applyValue(widget: mupdf.PDFWidget, value: string): void {
  if (widget.isReadOnly()) return;

  if (widget.isCheckbox() || widget.isRadioButton()) {
    const wantOn = isTruthy(value);
    if (wantOn !== isWidgetOn(widget)) widget.toggle();
    return;
  }

  if (widget.isChoice()) {
    widget.setChoiceValue(value);
    return;
  }

  widget.setTextValue(value);
}

export const fillFormTool: ToolDescriptor = {
  id: 'edit.fill-form',
  category: 'edit',
  name: { zh: '填写表单', en: 'Fill Form' },
  description: {
    zh: '列出或填写 PDF 交互式表单域。填写时每行一个「字段名=值」。',
    en: 'List or fill interactive PDF form fields. For filling, use one name=value line per field.',
  },
  icon: 'FilePenLine',
  keywords: ['form', 'acroform', 'fill', 'fields', '表单', '填写', '字段'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'mode',
      type: 'select',
      label: { zh: '操作', en: 'Action' },
      default: 'fill',
      options: [
        { value: 'fill', label: { zh: '填写并保存', en: 'Fill and save' } },
        { value: 'list', label: { zh: '仅列出字段', en: 'List fields only' } },
      ],
    },
    {
      key: 'fields',
      type: 'text',
      label: { zh: '字段值', en: 'Field values' },
      help: {
        zh: '每行一个：字段名=值。以 # 开头的行是注释。复选框可用 true/false 或 是/否。',
        en: 'One per line: name=value. Lines starting with # are comments. Checkboxes accept true/false.',
      },
      default: '',
      multiline: true,
      visibleWhen: { key: 'mode', equals: ['fill'] },
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const mode = stringParam(ctx, 'mode');
    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));

    try {
      const listed = listFormFields(doc);

      if (mode === 'list') {
        const rows: ReportRow[] = listed.map((field) => ({
          label: { zh: field.name, en: field.name },
          value: `${field.type}${field.readOnly ? ' (ro)' : ''}: ${field.value || '—'}`,
        }));
        ctx.report(1);
        return {
          files: [pdfOutput(file.name, file.bytes)],
          data: rows,
          summary: {
            zh: listed.length > 0 ? `共 ${listed.length} 个表单域` : '文档中没有表单域',
            en:
              listed.length > 0
                ? `${listed.length} form field(s)`
                : 'No form fields in this document',
          },
        };
      }

      const map = parseFieldMap(stringParam(ctx, 'fields'));
      if (map.size === 0) {
        throw new ToolError('INVALID_PARAM', 'No field values provided', {
          zh: '请填写至少一个「字段名=值」。可先用「仅列出字段」查看有哪些域。',
          en: 'Provide at least one name=value line. Use "List fields only" first to see available names.',
        });
      }

      let filled = 0;
      let missing = 0;
      const pageCount = doc.countPages();
      const known = new Set(listed.map((field) => field.name));

      for (let i = 0; i < pageCount; i += 1) {
        for (const widget of doc.loadPage(i).getWidgets()) {
          const name = widget.getName();
          if (!name || !map.has(name)) continue;
          applyValue(widget, map.get(name) as string);
          try {
            widget.update();
          } catch {
            // Some widget types have no appearance stream to refresh.
          }
          filled += 1;
        }
      }

      for (const name of map.keys()) {
        if (!known.has(name)) missing += 1;
      }

      const bytes = saveDocument(doc);
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_filled', '.pdf'), bytes)],
        summary: {
          zh:
            missing > 0
              ? `已填写 ${filled} 处（${missing} 个字段名在文档中不存在）`
              : `已填写 ${filled} 处表单域`,
          en:
            missing > 0
              ? `Filled ${filled} widget(s) (${missing} name(s) not found in the document)`
              : `Filled ${filled} form widget(s)`,
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
