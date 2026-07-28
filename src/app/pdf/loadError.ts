/**
 * Why a PDF failed to open in the viewer.
 *
 * Kept free of any pdfjs import so it stays testable outside a browser: the
 * classification only reads the shape of the thrown value.
 */
export type PdfLoadFailure = 'needs-password' | 'wrong-password' | 'unreadable';

/** `PasswordResponses` from pdfjs — stable public constants. */
const NEED_PASSWORD = 1;
const INCORRECT_PASSWORD = 2;

export function classifyLoadError(cause: unknown): PdfLoadFailure {
  if (typeof cause !== 'object' || cause === null) return 'unreadable';

  const { name, code } = cause as { name?: unknown; code?: unknown };
  if (name !== 'PasswordException') return 'unreadable';

  if (code === INCORRECT_PASSWORD) return 'wrong-password';
  if (code === NEED_PASSWORD) return 'needs-password';
  return 'unreadable';
}
