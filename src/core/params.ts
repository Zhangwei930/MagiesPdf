import { ToolError } from './errors.ts';
import type { LocalizedText, ParamSpec, ParamValue, ParamValues } from './types.ts';

/**
 * Validation and coercion for tool parameters.
 *
 * Three very different callers feed values in — the generated form (strings from
 * `<input>`), saved pipelines (JSON) and the REST API (JSON) — so everything is
 * coerced here rather than in each tool. A tool's `run` can trust its `ctx.params`.
 */

function reject(spec: ParamSpec, reason: string, user: LocalizedText): ToolError {
  return new ToolError(
    'INVALID_PARAM',
    `Parameter "${spec.key}" is invalid: ${reason}`,
    user,
    { key: spec.key },
  );
}

export function defaultParams(specs: readonly ParamSpec[]): ParamValues {
  const values: ParamValues = {};
  for (const spec of specs) {
    values[spec.key] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  }
  return values;
}

/** A param with an unmet `visibleWhen` is hidden in the form and skipped by validation. */
export function isParamVisible(spec: ParamSpec, values: Readonly<ParamValues>): boolean {
  if (!spec.visibleWhen) return true;
  return spec.visibleWhen.equals.includes(values[spec.visibleWhen.key]);
}

function coerceNumber(spec: ParamSpec, raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw reject(spec, `expected a number, got ${JSON.stringify(raw)}`, {
      zh: `「${spec.label.zh}」需要填写数字。`,
      en: `"${spec.label.en}" must be a number.`,
    });
  }
  return value;
}

function coerceBoolean(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === 'false' || raw === 0 || raw === '0') return false;
  return Boolean(raw);
}

const HEX_LONG = /^#[0-9a-f]{6}$/;
const HEX_SHORT = /^#[0-9a-f]{3}$/;

function coerceColor(spec: ParamSpec, raw: unknown): string {
  const value = String(raw).trim().toLowerCase();
  if (HEX_LONG.test(value)) return value;
  if (HEX_SHORT.test(value)) {
    return `#${[...value.slice(1)].map((c) => c + c).join('')}`;
  }
  throw reject(spec, `expected #rrggbb, got ${JSON.stringify(raw)}`, {
    zh: `「${spec.label.zh}」需要是 #rrggbb 形式的颜色值。`,
    en: `"${spec.label.en}" must be a colour in #rrggbb form.`,
  });
}

function validateOne(spec: ParamSpec, raw: unknown): ParamValue {
  switch (spec.type) {
    case 'text':
    case 'password': {
      const value = raw === undefined || raw === null ? '' : String(raw);
      if (spec.required && value.trim() === '') {
        throw reject(spec, 'is required but empty', {
          zh: `请填写「${spec.label.zh}」。`,
          en: `"${spec.label.en}" is required.`,
        });
      }
      if (spec.type === 'text' && spec.maxLength !== undefined && value.length > spec.maxLength) {
        throw reject(spec, `exceeds maxLength ${spec.maxLength}`, {
          zh: `「${spec.label.zh}」最多 ${spec.maxLength} 个字符。`,
          en: `"${spec.label.en}" is limited to ${spec.maxLength} characters.`,
        });
      }
      return value;
    }

    case 'pageRange': {
      const value = raw === undefined || raw === null ? '' : String(raw).trim();
      // The expression is only checked against a real page count inside the tool,
      // since the document is not loaded yet at this point.
      if (spec.required && value === '') {
        throw reject(spec, 'is required but empty', {
          zh: `请填写「${spec.label.zh}」。`,
          en: `"${spec.label.en}" is required.`,
        });
      }
      return value;
    }

    case 'number': {
      const value = coerceNumber(spec, raw);
      if (spec.integer && !Number.isInteger(value)) {
        throw reject(spec, 'must be an integer', {
          zh: `「${spec.label.zh}」必须是整数。`,
          en: `"${spec.label.en}" must be a whole number.`,
        });
      }
      if (spec.min !== undefined && value < spec.min) {
        throw reject(spec, `below min ${spec.min}`, {
          zh: `「${spec.label.zh}」不能小于 ${spec.min}。`,
          en: `"${spec.label.en}" must be at least ${spec.min}.`,
        });
      }
      if (spec.max !== undefined && value > spec.max) {
        throw reject(spec, `above max ${spec.max}`, {
          zh: `「${spec.label.zh}」不能大于 ${spec.max}。`,
          en: `"${spec.label.en}" must be at most ${spec.max}.`,
        });
      }
      return value;
    }

    case 'boolean':
      return coerceBoolean(raw);

    case 'color':
      return coerceColor(spec, raw);

    case 'select': {
      const value = String(raw);
      if (!spec.options.some((o) => o.value === value)) {
        throw reject(spec, `"${value}" is not one of the options`, {
          zh: `「${spec.label.zh}」的取值无效。`,
          en: `"${spec.label.en}" has an unsupported value.`,
        });
      }
      return value;
    }

    case 'multiselect': {
      const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(',').filter(Boolean);
      for (const entry of list) {
        if (!spec.options.some((o) => o.value === entry)) {
          throw reject(spec, `"${entry}" is not one of the options`, {
            zh: `「${spec.label.zh}」包含无效的选项。`,
            en: `"${spec.label.en}" contains an unsupported value.`,
          });
        }
      }
      if (spec.minSelected !== undefined && list.length < spec.minSelected) {
        throw reject(spec, `needs at least ${spec.minSelected} entries`, {
          zh: `「${spec.label.zh}」至少要选 ${spec.minSelected} 项。`,
          en: `"${spec.label.en}" needs at least ${spec.minSelected} selected.`,
        });
      }
      return list;
    }

    case 'file': {
      const value = raw === undefined || raw === null ? '' : String(raw);
      if (spec.required && value.trim() === '') {
        throw reject(spec, 'is required but empty', {
          zh: `请选择「${spec.label.zh}」。`,
          en: `"${spec.label.en}" is required.`,
        });
      }
      return value;
    }
  }
}

/**
 * Applies defaults, coerces and validates. Unknown keys are dropped so a stale
 * saved pipeline cannot smuggle values into a tool that no longer declares them.
 */
export function validateParams(
  specs: readonly ParamSpec[],
  raw: Readonly<Record<string, unknown>>,
): ParamValues {
  const values = defaultParams(specs);

  // First pass: coerce shallowly so `visibleWhen` conditions read normalised values.
  for (const spec of specs) {
    if (!(spec.key in raw)) continue;
    const provided = raw[spec.key];
    values[spec.key] =
      spec.type === 'boolean'
        ? coerceBoolean(provided)
        : (provided as ParamValue);
  }

  // Second pass: validate the params the user can actually see and edit.
  for (const spec of specs) {
    if (!isParamVisible(spec, values)) continue;
    values[spec.key] = validateOne(spec, values[spec.key]);
  }

  return values;
}
