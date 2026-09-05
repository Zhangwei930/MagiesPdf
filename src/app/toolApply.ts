import type { ToolMeta, ToolOutputFile } from '@core/types.ts';

/**
 * Deciding whether a tool can act on the document you are looking at.
 *
 * The catalogue says what a tool consumes but not what it produces, and adding
 * an output-type field would mean touching all 58 descriptors for something
 * only the shell cares about. So the input side is checked up front, and the
 * output side is read from the result: whatever comes back that is a single PDF
 * can replace the document; everything else is a file to save.
 */

/**
 * Whether a tool can run against the open document alone. It has to accept
 * PDFs, and it has to want exactly one file — a merge cannot be driven from a
 * single document, and neither can a tool that takes no files at all.
 */
export function canApplyToDocument(tool: ToolMeta): boolean {
  return tool.input.accept.includes('.pdf') && tool.input.max === 1 && tool.input.min <= 1;
}

/**
 * Whether the WPS-style task pane can host this tool while a PDF is open.
 * Multi-file tools are allowed: the current document is the first input, and
 * the pane asks for any extra files.
 */
export function canOpenFromDocument(tool: ToolMeta): boolean {
  if (!tool.input.accept.includes('.pdf')) return false;
  // Unlimited max (null) or max >= 1 means the open PDF can be the lead file.
  const max = tool.input.max;
  if (max === 0) return false;
  return tool.input.min >= 1 || (tool.input.min === 0 && (max === null || max >= 1));
}

/**
 * Params the task pane should show when applying to an open document.
 *
 * The document's own open password is the one thing the pane can answer by
 * itself, and `passwordParam()` always calls it `password`. Every other
 * password is one the user is *choosing* — the open password to set, the
 * permissions password, a certificate's passphrase — and hiding those left
 * encryption and certificate signing with no field to type into and a run
 * with an empty password.
 */
export function documentTaskParams(tool: ToolMeta): ToolMeta['params'] {
  return tool.params.filter((param) => !(param.type === 'password' && param.key === 'password'));
}

/**
 * WPS one-shot: rewrite the open PDF with no options and no extra files.
 * Password-only tools count as no options. Reports / multi-file exports still
 * need a pane so the user can see or save the result.
 */
export function canApplyInstantly(tool: ToolMeta): boolean {
  if (!canApplyToDocument(tool)) return false;
  if (documentTaskParams(tool).length > 0) return false;
  if (tool.input.min > 1) return false;
  return tool.output === 'single';
}

/**
 * Param types safe to run with catalogue defaults after a one-line confirm.
 * Free text / colour / file picks still need the task pane. Page ranges are
 * only allowed when the default is the whole document (`all`).
 */
const QUICK_DEFAULT_PARAM_TYPES = new Set(['boolean', 'select', 'number']);

function isQuickDefaultParam(param: ToolMeta['params'][number]): boolean {
  if (QUICK_DEFAULT_PARAM_TYPES.has(param.type)) return true;
  return param.type === 'pageRange' && String(param.default ?? '') === 'all';
}

/**
 * Single-PDF rewrite tools whose options are all simple defaults — confirm once
 * then apply, or open the pane via「更多选项」.
 */
export function canQuickApplyWithConfirm(tool: ToolMeta): boolean {
  if (!canApplyToDocument(tool) || tool.output !== 'single') return false;
  if (canApplyInstantly(tool)) return false;
  const params = documentTaskParams(tool);
  if (params.length === 0) return false;
  return params.every(isQuickDefaultParam);
}

export type ToolOutcome =
  /** One PDF came back: it becomes the document, and the change is undoable. */
  | { kind: 'document'; bytes: Uint8Array }
  /** Anything else — a conversion, a split, a report — is offered for saving. */
  | { kind: 'files' };

export function classifyOutput(files: readonly ToolOutputFile[]): ToolOutcome {
  const only = files.length === 1 ? files[0] : undefined;
  if (only && only.name.toLowerCase().endsWith('.pdf')) {
    return { kind: 'document', bytes: only.bytes };
  }
  return { kind: 'files' };
}
