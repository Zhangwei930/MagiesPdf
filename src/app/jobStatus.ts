import type { JobStatus } from './store.ts';

/**
 * Whether a job row may still change.
 *
 * A finished job is finished, and cancelling is the case that matters: the
 * user said stop, but the worker may still be part-way through whatever it was
 * doing and its progress messages keep arriving. One of those set the row back
 * to "running", and the result that followed then found a running job and
 * marked it done — so a job the user cancelled was reported as having
 * completed, with a result they never asked for.
 *
 * Only the two states that are still in motion accept anything.
 */
export function acceptsUpdate(status: JobStatus): boolean {
  return status === 'queued' || status === 'running';
}
