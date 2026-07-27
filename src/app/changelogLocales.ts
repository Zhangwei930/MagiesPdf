/**
 * Per-locale changelog sources (MagiesTerminal `application/i18n/changelog` pattern).
 * Root CHANGELOG.md remains the English GitHub-facing copy.
 */

import enRaw from './changelog/en.md?raw';
import zhRaw from './changelog/zh.md?raw';
import type { Locale } from './i18n.ts';

const BY_LOCALE: Record<Locale, string> = {
  zh: zhRaw,
  en: enRaw,
};

/** Return the changelog markdown for the active UI language. */
export function getChangelogRaw(locale: Locale): string {
  return BY_LOCALE[locale] ?? BY_LOCALE.en;
}
