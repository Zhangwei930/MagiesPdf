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
