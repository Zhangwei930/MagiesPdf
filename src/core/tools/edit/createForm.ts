import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ToolError } from '../../errors.ts';
import { decryptToBytes } from '../../pdf/document.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import { PDF_ONE, passwordParam, pdfOutput, soleFile, stringParam } from '../shared.ts';

/**
 * Adding interactive fields to a PDF.
 *
 * `edit.fill-form` fills fields that are already there, which leaves the person
 * who has the flat scan — the far commoner case — with nowhere to start. This
 * is the other half: it turns a printed form into one that can be completed on
 * screen, and every field it writes is a real AcroForm widget rather than a
 * drawn rectangle that looks like one.
 */

export type FieldKind = 'text' | 'check' | 'choice';

export interface FieldSpec {
  kind: FieldKind;
  name: string;
  /** 1-based, as the user counts pages. */
  page: number;
  /** PDF points from the bottom-left of the page, which is where PDF measures. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Choices, for a dropdown. Empty for the other kinds. */
  options: string[];
}

const KINDS = new Set<string>(['text', 'check', 'choice']);
const MAX_FIELDS = 200;

function positiveNumber(raw: string | undefined, label: string, line: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ToolError('INVALID_PARAM', `${label} must be a number in: ${line}`, {
      zh: `${label} 必须是数字：${line}`,
      en: `${label} must be a number in: ${line}`,
    });
  }
  return value;
}

/**
 * One field per line: `kind name page x y width height [choice|choice]`.
 *
 * A line that cannot be read is an error rather than a skip. A field silently
 * missing from a form is discovered by whoever has to fill it in, which is far
 * too late for them to do anything about it.
 */
export function parseFieldSpecs(text: string): FieldSpec[] {
  const specs: FieldSpec[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const [kind, name, page, x, y, width, height, ...rest] = parts;
    if (!kind || !KINDS.has(kind)) {
      throw new ToolError('INVALID_PARAM', `Unknown field type "${kind}" in: ${line}`, {
        zh: `未知的字段类型「${kind}」：${line}`,
        en: `Unknown field type "${kind}" in: ${line}`,
      });
    }
    if (!name || parts.length < 7) {
      throw new ToolError(
        'INVALID_PARAM',
        `Field "${name ?? ''}" needs a name, a page and a box: ${line}`,
        {
          zh: `字段「${name ?? ''}」需要名称、页码和位置尺寸：${line}`,
          en: `Field "${name ?? ''}" needs a name, a page and a box: ${line}`,
        },
      );
    }

    const pageNumber = positiveNumber(page, 'page', line);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new ToolError('INVALID_PARAM', `page must be 1 or greater in: ${line}`, {
        zh: `页码必须是不小于 1 的整数：${line}`,
        en: `page must be a whole number of 1 or more in: ${line}`,
      });
    }

    specs.push({
      kind: kind as FieldKind,
      name,
      page: pageNumber,
      x: positiveNumber(x, 'x', line),
      y: positiveNumber(y, 'y', line),
      width: positiveNumber(width, 'width', line),
      height: positiveNumber(height, 'height', line),
      options: rest.join(' ').split('|').map((option) => option.trim()).filter(Boolean),
    });
  }

  if (specs.length > MAX_FIELDS) {
    throw new ToolError('INVALID_PARAM', `At most ${MAX_FIELDS} fields`, {
      zh: `一次最多添加 ${MAX_FIELDS} 个字段`,
      en: `At most ${MAX_FIELDS} fields at a time`,
    });
  }
  return specs;
}

export const createFormTool: ToolDescriptor = {
  id: 'edit.create-form',
  category: 'edit',
  name: { zh: '创建表单域', en: 'Create Form Fields' },
  description: {
    zh: '在 PDF 上添加可填写的表单域：文本框、复选框、下拉框。每行一个字段。',
    en: 'Add fillable form fields to a PDF: text boxes, checkboxes and dropdowns. One per line.',
  },
  icon: 'FilePenLine',
  keywords: ['form', 'acroform', 'field', 'fillable', '表单', '字段', '可填写', '复选框'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'fields',
      type: 'text',
      label: { zh: '字段', en: 'Fields' },
      help: {
        zh: '每行一个：类型 名称 页码 X Y 宽 高。类型为 text/check/choice；'
          + 'choice 在尺寸后追加「选项1|选项2」。坐标以页面左下角为原点，单位为点。',
        en: 'One per line: kind name page x y width height. Kinds are text, check and choice; '
          + 'a choice adds "one|two" after the box. Coordinates are PDF points from the '
          + 'bottom-left of the page.',
      },
      default: 'text 姓名 1 72 700 200 24',
      multiline: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const specs = parseFieldSpecs(stringParam(ctx, 'fields'));
    if (specs.length === 0) {
      throw new ToolError('INVALID_PARAM', 'Describe at least one field', {
        zh: '请至少描述一个表单域',
        en: 'Describe at least one field',
      });
    }

    const doc = await PDFDocument.load(
      decryptToBytes(file.bytes, stringParam(ctx, 'password')),
    );
    const form = doc.getForm();
    const pages = doc.getPages();
    // One font for every field, so the appearance streams share it rather than
    // embedding a copy each.
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for (const spec of specs) {
      const page = pages[spec.page - 1];
      if (!page) {
        throw new ToolError('INVALID_PARAM', `Field "${spec.name}" names page ${spec.page}, but the document has ${pages.length}`, {
          zh: `字段「${spec.name}」指向第 ${spec.page} 页，但文档只有 ${pages.length} 页`,
          en: `Field "${spec.name}" names page ${spec.page}, but the document has ${pages.length}`,
        });
      }
      const { width: pageWidth, height: pageHeight } = page.getSize();
      if (
        spec.x < 0 || spec.y < 0
        || spec.x + spec.width > pageWidth || spec.y + spec.height > pageHeight
      ) {
        // A widget outside the page is not clipped, it is simply invisible, and
        // the form comes back with a field nobody could find.
        throw new ToolError('INVALID_PARAM', `Field "${spec.name}" falls outside page ${spec.page}`, {
          zh: `字段「${spec.name}」超出第 ${spec.page} 页的范围`,
          en: `Field "${spec.name}" falls outside page ${spec.page}`,
        });
      }

      const box = { x: spec.x, y: spec.y, width: spec.width, height: spec.height };
      if (spec.kind === 'text') {
        const field = form.createTextField(spec.name);
        field.addToPage(page, { ...box, font, borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 1 });
      } else if (spec.kind === 'check') {
        form.createCheckBox(spec.name).addToPage(page, {
          ...box, borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 1,
        });
      } else {
        if (spec.options.length === 0) {
          throw new ToolError('INVALID_PARAM', `Dropdown "${spec.name}" needs choices`, {
            zh: `下拉框「${spec.name}」需要至少一个选项`,
            en: `Dropdown "${spec.name}" needs at least one choice`,
          });
        }
        const dropdown = form.createDropdown(spec.name);
        dropdown.addOptions(spec.options);
        dropdown.addToPage(page, { ...box, font, borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 1 });
      }
      ctx.report(specs.indexOf(spec) / specs.length);
    }

    ctx.report(1);
    return {
      files: [pdfOutput(suffixedName(file.name, 'form'), await doc.save())],
      summary: {
        zh: `已添加 ${specs.length} 个表单域`,
        en: `Added ${specs.length} form ${specs.length === 1 ? 'field' : 'fields'}`,
      },
    };
  },
};
