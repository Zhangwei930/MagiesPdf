/**
 * Lightweight changelog parser — same role as MagiesTerminal's
 * `domain/changelog.ts`. Locale-specific markdown lives in
 * `changelog/zh.md` / `changelog/en.md` and is selected via
 * `getChangelogRaw` in `changelogLocales.ts`.
 */

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date?: string;
  sections: ChangelogSection[];
}

/** Parse MagiesPdf changelog markdown (## version headers, ### sections, - items). */
export function parseChangelog(raw: string): ChangelogEntry[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;

  const flushSection = () => {
    if (current && section && (section.items.length > 0 || section.title)) {
      current.sections.push(section);
    }
    section = null;
  };

  const flushEntry = () => {
    flushSection();
    if (current) entries.push(current);
    current = null;
  };

  for (const line of lines) {
    const versionMatch = /^##\s+v?([\d.]+)\s*(?:[—–-]\s*(.+))?\s*$/.exec(line);
    if (versionMatch) {
      flushEntry();
      current = {
        version: versionMatch[1] ?? '',
        date: versionMatch[2]?.trim() || undefined,
        sections: [],
      };
      continue;
    }

    if (!current) continue;

    const sectionMatch = /^###\s+(.+)\s*$/.exec(line);
    if (sectionMatch) {
      flushSection();
      section = { title: (sectionMatch[1] ?? '').trim(), items: [] };
      continue;
    }

    const bullet = /^[-*]\s+(.+)\s*$/.exec(line);
    if (bullet) {
      if (!section) section = { title: '', items: [] };
      section.items.push((bullet[1] ?? '').trim());
      continue;
    }

    // Lead-in paragraph under a version (no section yet) → treat as intro items.
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('|') && !trimmed.startsWith('```')) {
      if (!section) section = { title: '', items: [] };
      // Skip pure table separators / pack script fences handled above.
      if (!/^[-=|:\s]+$/.test(trimmed)) {
        section.items.push(trimmed);
      }
    }
  }

  flushEntry();
  return entries;
}

export function countChangelogItems(entry: ChangelogEntry): number {
  return entry.sections.reduce((n, s) => n + s.items.length, 0);
}
