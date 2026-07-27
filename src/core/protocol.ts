import type { SerializedToolError } from './errors.ts';
import type { LocalizedText, ToolOutputFile } from './types.ts';

/**
 * Wire format between the renderer, the Electron main process and the worker pool.
 *
 * Everything here must survive `structuredClone`: plain objects, strings, numbers
 * and `Uint8Array`. No class instances, no functions — which is why `ToolError`
 * travels as {@link SerializedToolError} rather than as itself.
 */

export interface SerializedFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export interface JobRequest {
  jobId: string;
  toolId: string;
  files: SerializedFile[];
  params: Record<string, unknown>;
}

export type WorkerInbound =
  | ({ type: 'run' } & JobRequest)
  | { type: 'cancel'; jobId: string };

export interface JobProgress {
  type: 'progress';
  jobId: string;
  fraction: number;
  message?: LocalizedText;
}

export interface JobDone {
  type: 'done';
  jobId: string;
  files: ToolOutputFile[];
  data?: unknown;
  summary?: LocalizedText;
}

export interface JobFailed {
  type: 'error';
  jobId: string;
  error: SerializedToolError;
}

export type WorkerOutbound = JobProgress | JobDone | JobFailed;

/** Collects every `ArrayBuffer` in a message so it can be transferred, not copied. */
export function transferablesOf(files: readonly { bytes: Uint8Array }[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const file of files) {
    const { buffer } = file.bytes;
    // A view over a shared or already-listed buffer must not be transferred twice.
    if (buffer instanceof ArrayBuffer && !buffers.includes(buffer)) buffers.push(buffer);
  }
  return buffers;
}
