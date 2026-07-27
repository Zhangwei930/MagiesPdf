# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

MagiesPdf is a local-first desktop PDF toolbox: Electron main process + React 19
renderer + an isomorphic TypeScript engine that runs in worker threads.
Node.js 22+. Licensed AGPL-3.0-or-later (MuPDF is AGPL; that choice is load-bearing).

## Commands

```bash
npm run dev       # worker bundle + catalogue, then Vite and Electron concurrently
npm run verify    # lint + typecheck + test + build — run this before committing
npm test          # node:test via tsx
node --test --import tsx src/core/pageRange.test.ts    # single file
node --test electron/jobs/pool.test.cjs                # needs `npm run build:node` first
npm run pack:mac / pack:win / pack:linux
```

## Layer rules

Three layers, enforced by ESLint and by the build:

- **`src/core/`** — isomorphic. No DOM, no Electron, no React. Runs in a bare worker
  thread. ESLint blocks `window`/`document`/`localStorage` and imports of
  `electron`/`react`/`@app/*` here. Do not weaken those rules to make something work;
  the thing belongs in another layer.
- **`electron/`** — CommonJS `.cjs`. Window lifecycle, IPC, the worker pool, the updater.
  Every IPC handler is a boundary against untrusted renderer input: validate paths
  and sizes there, not in the caller.
- **`src/app/`** — the renderer. Metadata only. It must never import `src/core/tools/`,
  `mupdf` or `pdf-lib`. It gets the catalogue as data over `catalog:get`.

If the renderer bundle jumps past ~300 KB or a `.wasm` appears in `dist/assets/`,
that boundary has been broken.

## Adding a tool

One file under `src/core/tools/<category>/`, exporting a `ToolDescriptor`, plus one
import in `src/core/tools/index.ts`. That is the whole job — the card grid, the
generated options form, ⌘K search, the pipeline palette and the REST route all read
from the descriptor.

Rules that matter:

- `id` must be `category.name` and the prefix must match `category` (the registry
  enforces this).
- Names, descriptions, param labels and help are **inline bilingual** (`{ zh, en }`),
  not i18n keys. Self-contained beats a key that can dangle.
- Accept `passwordParam()` on anything that reads a PDF. Users have encrypted files.
- Errors are `ToolError` with a `ToolErrorCode` and a bilingual `userMessage`.
  The renderer switches on `code`; never encode meaning into the message string.
- `runtime: 'main'` only if the tool genuinely needs `ctx.host` (Chromium's
  `printToPDF`, the external converter). Everything else is `'worker'`.
- Write the failing test first. `src/core/testing/fixtures.ts` builds sample PDFs,
  encrypts them and reads page text back.

## MuPDF gotchas

These have each cost a real bug:

- **`saveToBuffer(...).asUint8Array()` returns a view into the WASM heap, not a copy.**
  It dangles once the buffer is freed and cannot be transferred across a worker
  boundary. `saveDocument()` copies; go through it.
- **MuPDF's default save is `encrypt=keep`** — it silently carries the source file's
  encryption into the output. Every save must state its intent. `saveDocument()`
  writes `encrypt=none` unless asked otherwise.
- **A default save already compresses streams.** The `compress` flag alone changes
  nothing; real savings come from image/font handling and garbage collection.
- **Every MuPDF object needs `.destroy()`.** Use `withDocument`/`withDocumentSync`.
- `asPNG()` and friends *do* copy (they use `.slice()`), so those are safe.

## PDF permissions

Authenticating with the **owner** password grants every permission. So an owner
password defaulted to the user password makes restrictions meaningless — anyone who
can open the file holds owner rights. See `resolveOwnerPassword`, which generates a
random owner password when restrictions are set but none was supplied.

## Distribution

Source and release tags live in `Zhangwei930/MagiesPdf`. Dual-link updates
(same model as MagiesTerminal):

- **Overseas** — GitHub Releases on this repo (`electron-updater` github provider)
- **Mainland China** — Cloudflare Worker at `dl.magies.top/magiespdf/stable`
  (generic provider; see `mirror-worker/`)

Selection is client-side on locale / time zone (`preferMirror` in
`electron/updater/releaseChannel.cjs`). Both feeds are always tried with
fallback. Windows arm64 uses channel `latest-arm64`.

## Conventions

- RED → GREEN → REFACTOR. A failing test before the production change.
- Conventional Commits, scoped: `feat(organize): add booklet imposition`,
  `fix(pdf): copy save buffer out of the WASM heap`.
- Branch per change (`feat/…`, `fix/…`). Small, focused PRs.
- Never bundle, reference or mention any third-party office-suite binary. Office
  conversion uses Chromium's `printToPDF` plus a user-configurable, unnamed external
  converter hook.
