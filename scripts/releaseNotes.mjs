import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * The release body, taken from CHANGELOG.md.
 *
 * The changelog is written once, by hand, for humans; a release whose notes are
 * generated from commit subjects says something different and usually worse. So
 * the workflow lifts the section that was already written for this version.
 */

/** `refs/tags/v1.0.4` → `1.0.4`. Empty for anything that is not a version tag. */
export function versionFromRef(ref) {
  if (typeof ref !== 'string') return '';
  const name = ref.replace(/^refs\/tags\//, '');
  // Strict: `v1.0` and `v-test` are not releases, and must not become one.
  return /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(name) ? name.slice(1) : '';
}

/**
 * The body of one `## <version>` section, without its own heading — the release
 * title already carries the version.
 */
export function sectionFor(changelog, version) {
  if (typeof changelog !== 'string' || typeof version !== 'string') return '';
  const wanted = version.replace(/^v/, '');
  if (wanted === '') return '';

  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const collected = [];
  let inside = false;

  for (const line of lines) {
    const heading = /^##\s+v?([\d.]+(?:-[0-9A-Za-z.-]+)?)\s*(?:[—–-].*)?$/.exec(line);
    if (heading) {
      // Compare whole versions, so 1.0 does not match 1.0.4 and 1.0.4 does not
      // match 1.0.40.
      if (heading[1] === wanted) {
        inside = true;
        continue;
      }
      if (inside) break;
      continue;
    }
    if (inside) collected.push(line);
  }

  return collected.join('\n').trim();
}

// Used by the release workflow: `node scripts/releaseNotes.mjs <ref>`. Only when
// run directly — importing it from the tests must not print or exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const version = versionFromRef(process.argv[2] ?? process.env.GITHUB_REF ?? '');
  if (version === '') {
    console.error('[release-notes] not a v<major>.<minor>.<patch> tag; nothing to write');
    process.exit(1);
  }
  const notes = sectionFor(readFileSync('CHANGELOG.md', 'utf8'), version);
  if (notes === '') {
    console.error(`[release-notes] CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
