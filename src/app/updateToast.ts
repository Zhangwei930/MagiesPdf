import type { UpdaterStatus } from './bridge.ts';

/**
 * Visibility rules for the update toast.
 *
 * Kept out of the component so the "when does this reappear" logic — the part
 * that decides whether a user who closed the toast gets it back — is testable
 * on its own.
 */

/** What the user closed, so the same news is not repeated at them. */
export interface Dismissal {
  version: string | null;
  state: UpdaterStatus['state'];
}

/** States where the toast has something for the user to act on. */
export function isActionable(state: UpdaterStatus['state']): boolean {
  return (
    state === 'available' || state === 'downloading' || state === 'ready' || state === 'installing'
  );
}

/**
 * Whether the toast should be on screen for `next`.
 *
 * Every state can be closed, including `ready` — the toast is only a notice,
 * and Settings keeps the install button either way. Closing suppresses that
 * version until it reaches `ready`, which is genuinely new: the update stopped
 * being a background download and is now waiting on a restart.
 */
export function shouldShowToast(next: UpdaterStatus, dismissed: Dismissal | null): boolean {
  if (next.state === 'error') return true;
  if (!isActionable(next.state)) return false;
  if (!dismissed) return true;

  if ((next.version ?? null) !== dismissed.version) return true;
  return next.state === 'ready' && dismissed.state !== 'ready';
}
