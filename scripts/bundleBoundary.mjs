/**
 * The layer boundary, as something the build can actually check.
 *
 * CLAUDE.md says the renderer must never import `src/core/tools/`, `mupdf` or
 * `pdf-lib`, and offered a bundle size past ~300 KB as the sign that it had.
 * Size is a poor stand-in: react-dom alone is ~130 KB, so the number was going
 * to be exceeded by an app that had broken nothing, and a real violation could
 * hide under it. This checks the thing itself instead.
 *
 * The evidence is the entry chunk's sourcemap, whose `sources` list every file
 * that went into it — the module graph, not a guess about minified text.
 */

/**
 * Packages that carry a PDF engine. None of them belongs anywhere in the
 * renderer — not in the entry chunk, and not hiding in a lazily-loaded screen.
 */
export const ENGINE_PACKAGES = Object.freeze([
  'mupdf',
  'pdf-lib',
  'mammoth',
  'tesseract.js',
  'tesseract.js-core',
  'node-forge',
  'pkijs',
  'asn1js',
  '@signpdf/signpdf',
  '@signpdf/signer-p12',
  '@signpdf/placeholder-pdf-lib',
]);

/**
 * pdfjs-dist is the exception, and a deliberate one: it is the renderer's own
 * read-only page renderer, unrelated to the engines in src/core, and it never
 * writes a PDF. It is allowed — but only in a lazily-loaded chunk, because it
 * is ~1 MB and nothing should pay for it before opening a document.
 */
export const VIEWER_ONLY_PACKAGES = Object.freeze(['pdfjs-dist']);

/**
 * Which engine packages contributed source to a chunk.
 *
 * Matching on `node_modules/<name>/` rather than on the name anywhere in the
 * path is what keeps `pdf-lib-fontkit` from being read as `pdf-lib`, and app
 * code that merely mentions an engine from tripping the check.
 */
export function enginesIn(sources, engines = ENGINE_PACKAGES) {
  if (!Array.isArray(sources)) return [];

  const found = [];
  for (const engine of engines) {
    const marker = `node_modules/${engine}/`;
    const present = sources.some((source) => typeof source === 'string' && source.includes(marker));
    if (present) found.push(engine);
  }
  return found;
}

/**
 * Assets that only exist because an engine was bundled. MuPDF and Tesseract
 * both ship WebAssembly, so a `.wasm` in the renderer's output is the loudest
 * possible sign the boundary went.
 */
export function enginePayloads(fileNames) {
  if (!Array.isArray(fileNames)) return [];
  return fileNames.filter((name) => typeof name === 'string' && name.toLowerCase().endsWith('.wasm'));
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * Every way the renderer's output can be wrong, reported together — one run
 * should tell you everything, not the first thing.
 *
 * `chunks` is every JavaScript chunk, each with the sources that built it; the
 * engine rules apply to all of them, while the size ceiling is the entry
 * chunk's alone (the viewer chunk is far larger and always will be).
 */
export function checkRendererBundle({ chunks, assets, entryName, limit }) {
  const problems = [];
  const all = Array.isArray(chunks) ? chunks : [];

  for (const chunk of all) {
    const engines = enginesIn(chunk?.sources);
    if (engines.length > 0) {
      problems.push(
        `${chunk.name} contains ${engines.join(', ')}. Engines belong in src/core, ` +
          'which runs in the worker pool — the renderer gets tool metadata over ' +
          '`catalog:get` and nothing more.',
      );
    }
  }

  const entry = all.find((chunk) => chunk?.name === entryName);
  if (!entry) {
    problems.push(`No entry chunk named ${entryName} among ${all.length} chunk(s).`);
  } else {
    const eager = enginesIn(entry.sources, VIEWER_ONLY_PACKAGES);
    if (eager.length > 0) {
      problems.push(
        `The entry chunk contains ${eager.join(', ')}, which must stay in a lazily ` +
          'loaded chunk — it is ~1 MB, and nothing should pay for it before a ' +
          'document is opened.',
      );
    }

    if (entry.byteLength > limit) {
      problems.push(
        `The entry chunk is ${kb(entry.byteLength)}, over its ${kb(limit)} ceiling. ` +
          'Either something conditional became eager — check whether a new screen ' +
          'should be lazily imported the way the Viewer is — or the ceiling needs ' +
          'raising deliberately, with a reason.',
      );
    }
  }

  const payloads = enginePayloads(assets);
  if (payloads.length > 0) {
    problems.push(
      `dist/assets contains ${payloads.join(', ')}. A .wasm in the renderer's ` +
        'output means an engine was bundled with it.',
    );
  }

  return { ok: problems.length === 0, problems };
}
