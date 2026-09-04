import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * This codebase writes Tailwind utilities in `className` and real CSS in
 * stylesheets, and the two look alike enough to swap by accident:
 * `items-center: center` is a utility name in a property's place. It parses as
 * an unknown property, so nothing complains — no build error, no console
 * warning — and the rule silently does nothing. That is how the HUD badge
 * ended up not centring anything (issue #35).
 *
 * A full CSS property validator would need a property list to maintain. These
 * are the handful whose utility spelling is a plausible slip, which is the
 * whole of the observed problem.
 */
const UTILITY_LOOKALIKES = [
  'items-center',
  'items-start',
  'items-end',
  'items-baseline',
  'items-stretch',
  'justify-center',
  'justify-between',
  'justify-around',
  'justify-start',
  'justify-end',
  'content-center',
  'content-between',
  'self-center',
  'self-start',
  'self-end',
  'flex-col',
  'flex-row',
  'flex-wrap',
  'text-center',
  'text-left',
  'text-right',
];

const STYLE_DIR = new URL('.', import.meta.url).pathname;

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

describe('stylesheets', () => {
  it('never uses a Tailwind utility name where a CSS property belongs', () => {
    const offences: string[] = [];

    for (const file of stylesheets(STYLE_DIR)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const property = /^\s*([a-z-]+)\s*:/.exec(line)?.[1];
        if (property === undefined) return;
        if (UTILITY_LOOKALIKES.includes(property)) {
          offences.push(`${file.split('/src/')[1]}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(offences, []);
  });
});
