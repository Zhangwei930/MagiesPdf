import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * Regenerates `dist-electron/catalog.json` after every bundle, including each
 * rebuild in `--watch`. Editing a tool descriptor has to update what the UI
 * sees, and the catalogue lives in the same directory as the worker bundle.
 */
function catalogPlugin(): Plugin {
  return {
    name: 'magiespdf:catalog',
    closeBundle() {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/generate-catalog.mjs'], {
        stdio: 'inherit',
      });
    },
  };
}

/**
 * Node-side bundle: the worker entry plus the isomorphic tool core it pulls in.
 * Electron's main process spawns `dist-electron/worker.mjs` from a worker_thread,
 * so this has to be real ESM on disk — the renderer bundle can't serve it.
 */
export default defineConfig({
  plugins: [catalogPlugin()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-electron',
    // Never wipe the directory: `--watch` rebuilds on every save, and clearing
    // it would delete `catalog.json` out from under the running app. The `clean`
    // script handles a genuine fresh build.
    emptyOutDir: false,
    target: 'node22',
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        // Worker-thread entry (message loop around the core).
        worker: fileURLToPath(new URL('./src/node/worker.ts', import.meta.url)),
        // The same core as a plain library, imported by the main process for
        // `runtime: 'main'` tools.
        core: fileURLToPath(new URL('./src/node/coreEntry.ts', import.meta.url)),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      // Rolldown otherwise treats a bare `crypto` — which a CJS dependency
      // imports without the `node:` prefix — as an external CommonJS module and
      // emits its own `require` helper. The output is ESM on disk and runs in a
      // worker thread, where there is no `require`, so every job died with
      // "Calling `require` for \"crypto\" in an environment that doesn't expose
      // the `require` function". Naming the platform makes builtins builtins.
      platform: 'node',
      // Native/WASM-backed deps stay external so they resolve from node_modules at runtime.
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
        'mupdf',
        'tesseract.js',
        // Pure-JS but heavy; resolved from node_modules at runtime keeps the
        // two entry bundles from double-bundling them.
        'marked',
        'mammoth',
        'xlsx',
      ],
    },
  },
});
