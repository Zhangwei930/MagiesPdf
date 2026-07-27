import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_TOOLS } from '../src/core/tools/index.ts';
import { toToolMeta } from '../src/core/types.ts';

/**
 * Writes the tool catalogue as plain data for the renderer.
 *
 * The renderer needs each tool's metadata to draw its card and its options form,
 * but must not import the tool modules themselves — doing so drags MuPDF's 10 MB
 * WASM binary and pdf-lib into a bundle that never executes them. Emitting the
 * metadata here keeps one descriptor per tool as the single source of truth while
 * the process boundary stays honest.
 *
 * Run with tsx: `node --import tsx scripts/generate-catalog.mjs`
 */

const outputPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-electron', 'catalog.json');

const catalog = {
  generatedAt: new Date().toISOString(),
  tools: ALL_TOOLS.map(toToolMeta),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

console.warn(`[magiespdf] wrote ${catalog.tools.length} tools to dist-electron/catalog.json`);
