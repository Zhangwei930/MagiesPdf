# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

MagiesPdf is a local-first desktop PDF toolbox: Electron main process + React 19
renderer + an isomorphic TypeScript engine that runs in worker threads.
Node.js 22+. Licensed AGPL-3.0-or-later (MuPDF is AGPL; that choice is load-bearing).

## Commands

```bash
npm run dev       # worker bundle + catalogue, then Vite and Electron concurrently
npm run verify    # lint + typecheck + test:coverage + build — run this before committing
npm test          # node:test via tsx (src/, electron/, mirror-worker/)
npm run test:coverage  # c8, gated at 80% lines/statements/functions, 75% branches
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
that boundary has been broken. (It is currently over that line at ~340 KB and has
been for a while — treat the number as a tripwire for *new* growth, not a claim
that the budget is being met.)

## The renderer is document-centric

The shell is built around open documents, not around tools:

- `src/app/documents.ts` owns what a document is — bytes, an undo `past` and
  `future`, whether it is on disk. Pure and tested; the store only decides which
  document an action applies to. History is capped by **bytes as well as steps**,
  because ten copies of a large scan across several tabs will exhaust memory.
- Open documents live in the store as a list with an active id, rendered as tabs.
  A document survives navigating away, so there is no "you will lose your edits"
  guard — the only prompt left is closing a dirty tab.
- **Editing belongs to the store, not the Viewer.** The Viewer renders and calls
  `editDocument`; that is what lets a tool run land in the same undo history as a
  page rotation.
- Picking a tool with a document in view runs it against that document
  (`applyToolToDocument`). Whether that is possible is decided in two halves, in
  `src/app/toolApply.ts`: the input side from the descriptor (exactly one PDF),
  the output side from the actual result (a lone PDF replaces the document,
  anything else is offered for saving). **Do not add an output-type field to the
  descriptors for this** — the shell is the only thing that cares, and it can
  already tell by looking.

Layout maths for the continuous-scroll viewer is in `src/app/pdf/layout.ts`, and
keyboard shortcuts are a pure mapping in `src/app/shortcuts.ts`. Both are there so
they can be tested without a DOM; keep new logic of that kind out of components.

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
