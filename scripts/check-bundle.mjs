import { globSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { checkRendererBundle } from './bundleBoundary.mjs';

/**
 * Enforces the renderer's layer boundary against the built output.
 *
 * Run after `npm run build`. The rules and the reasoning live in
 * `bundleBoundary.mjs`; this only gathers the evidence off disk.
 */

/**
 * The entry chunk's ceiling.
 *
 * Set from the measured size with room to grow, not from a round number: the
 * floor is react-dom at ~130 KB and the rest is the shell itself, so a number
 * chosen for its shape would either be unreachable or meaningless. At the time
 * of writing the chunk is ~280 KB, leaving about 14% of headroom.
 *
 * Raising this is a decision to record here, with a reason. Going red usually
 * means something conditional became eager — check whether a new screen should
 * be lazily imported the way the Viewer and the settings panel are.
 */
const ENTRY_LIMIT_BYTES = 320 * 1024;

const ASSETS = path.join(process.cwd(), 'dist', 'assets');

function fail(message) {
  console.error(`\n[bundle] ${message}\n`);
  process.exit(1);
}

/**
 * Every chunk, with the sources that built it.
 *
 * The sourcemap is the module graph, which is exact — searching minified text
 * for a package name would both miss renamed identifiers and fire on comments.
 * A chunk without a readable map is treated as a failure rather than skipped:
 * passing on missing evidence is the one outcome a check must never have.
 */
function readChunks() {
  return globSync(path.join(ASSETS, '*.js')).map((file) => {
    const name = path.basename(file);
    try {
      return {
        name,
        byteLength: statSync(file).size,
        sources: JSON.parse(readFileSync(`${file}.map`, 'utf8')).sources ?? [],
      };
    } catch {
      fail(`No readable sourcemap beside ${name}; the boundary cannot be verified.`);
      return null;
    }
  });
}

const entries = globSync(path.join(ASSETS, 'index-*.js'));
if (entries.length !== 1 || !entries[0]) {
  fail(
    `Expected exactly one entry chunk in dist/assets, found ${entries.length}. ` +
      'Run `npm run build` first.',
  );
}

const chunks = readChunks();
const entryName = path.basename(entries[0]);
const { ok, problems } = checkRendererBundle({
  chunks,
  assets: readdirSync(ASSETS),
  entryName,
  limit: ENTRY_LIMIT_BYTES,
});

if (!ok) {
  fail(`Renderer boundary check failed:\n\n  - ${problems.join('\n\n  - ')}`);
}

const entry = chunks.find((chunk) => chunk.name === entryName);
console.log(
  `[bundle] ${chunks.length} chunks checked, entry ${(entry.byteLength / 1024).toFixed(1)} KB — ` +
    'no engines outside the worker, no wasm, boundary intact.',
);
