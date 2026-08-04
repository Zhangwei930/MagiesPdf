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
npm run prepare:engine -- --shared              # the editor and its fonts, once
npm run prepare:engine -- --platform=win32 --arch=arm64   # one target's converter
npm run fonts:engine   # regenerate the font manifest from the fonts that ship
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

`npm run check:bundle` enforces this against the built output, and `npm run verify`
runs it. It reads the entry chunk's sourcemap — the module graph, not a guess about
minified text — and fails if any engine package contributed to it, if a `.wasm`
appears in `dist/assets/`, or if the chunk outgrew its ceiling. The rules and the
reasoning are in `scripts/bundleBoundary.mjs`; the ceiling is in
`scripts/check-bundle.mjs` and raising it is a decision to record there.

Screens that most sessions never open are lazily imported in `App.tsx` — the
Viewer (pdfjs-dist is ~1 MB on its own), settings, the pipeline builder, the batch
runner and the signature pad. Add new heavy screens the same way.

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

## The Office engine

Word, Sheet and Slide documents open in an ONLYOFFICE editor embedded in the
same window. Two separate things make that work, and they are not
interchangeable:

- **The converter** (`vendor/onlyoffice/<os>-<arch>/converter`) — native, one
  per platform. It converts between a document and the editor's own binary
  format. That is all this app asks of it.
- **The editor** (`vendor/onlyoffice/shared/web`) — the Document Server build,
  javascript and fonts, identical everywhere. It is the *only* build that can
  save: the desktop build's save path is an unconditional call into a native
  host that is not here, with no cloud branch to fall back on.

A checkout keeps the shared half once and links it into each target, so a
checkout has the same shape as a packaged app. `npm run prepare:engine --
--shared` builds it; `-- --platform=win32 --arch=arm64` fetches one target's
converter. `npm run fonts:engine` regenerates the font manifest.

There is no server. `electron/office/editorHost.cjs` serves the editor over
loopback and answers what a document server would: the socket is a stand-in
(`socketStubSource`), the handshake is pushed rather than answered, and
`themes.json`/`plugins.json` are empty. `MAGIES_EDITOR_TRACE=1` logs every
request the editor makes, which is how anything here gets diagnosed.

Things that have each cost hours:

- **Fonts must be served obfuscated.** The engine exclusive-ors the first 32
  bytes of every font it downloads, undoing the ODTTF obfuscation a document
  server stores them under. Serving a plain font *applies* that instead, and
  FreeType then opens nothing — which surfaces far away, as a null face while
  the ribbon's style gallery is drawn.
- **The font manifest is generated** (`scripts/onlyofficeFonts.mjs`), not
  shipped. It needs four globals, and the engine fails differently without
  each: `__fonts_files`, `__fonts_infos`, `g_fonts_selection_bin` — which must
  be *declared* even when empty, because the check is `!= ""` and undefined
  passes it — and `__fonts_ranges`. The `ASCW3` row must not be emitted: the
  engine drops it while building its own list without advancing the index,
  which shifts every family after it.
- **Saving is an upload.** `downloadAs` on the engine's own api, with no action
  type and a callback — not the embedding interface's download, which blocks
  the editor behind a dialog and ends by fetching the file it produced. The
  document arrives at `/editors/downloadas/<session>`; the document's `key`
  must *be* the session, or there is nothing to match the upload to.
- **PDF previews go through the bundled LibreOffice**, not the converter. The
  converter's own PDF rendering needs a font manifest describing the machine it
  runs on, which cannot be shipped.

## Distribution

Source and release tags live in `Zhangwei930/MagiesPdf`. Dual-link updates
(same model as MagiesTerminal):

- **Overseas** — GitHub Releases on this repo (`electron-updater` github provider)
- **Mainland China** — Cloudflare Worker at `dl.magies.top/magiespdf/stable`
  (generic provider; see `mirror-worker/`)

Selection is client-side on locale / time zone (`preferMirror` in
`electron/updater/releaseChannel.cjs`). Both feeds are always tried with
fallback. Windows arm64 uses channel `latest-arm64`.

**The mirror is a proxy, not a copy.** `mirror-worker/` reads GitHub's *latest*
release on each request and streams the assets through; it stores nothing. So
there is no upload step, and nothing to keep in sync — the mirror serves a new
version the moment the GitHub Release exists. Two consequences worth knowing:
a prerelease tag deliberately never reaches mainland users, because GitHub's
`releases/latest` skips prereleases; and un-publishing a GitHub Release takes
the mirror down with it.

### Releasing

Bump the version and write the entry in `CHANGELOG.md` **and** the in-app copies
in `src/app/changelog/{zh,en}.md` — the app's "What's New" reads the latter, and
`CHANGELOG.md` keeps the sentence-final full stops that the in-app copy drops.
Then push a `v<major>.<minor>.<patch>` tag.

`.github/workflows/release.yml` takes it from there: it verifies, builds every
platform on its own runner, and publishes the GitHub Release with notes lifted
from `CHANGELOG.md` by `scripts/releaseNotes.mjs`. Each platform builds natively
because it has to — a Windows NSIS installer needs Wine anywhere else, and a
`.deb` needs fpm — so a release cannot be cut from one machine by hand. The job
refuses to publish unless every platform produced something, so one platform's
updater is never left looking for a feed that is not there.

Loose tags (`v1.0`, `v-test`) do not match the trigger and cannot publish by
accident.

## Conventions

- RED → GREEN → REFACTOR. A failing test before the production change.
- Conventional Commits, scoped: `feat(organize): add booklet imposition`,
  `fix(pdf): copy save buffer out of the WASM heap`.
- Branch per change (`feat/…`, `fix/…`). Small, focused PRs.
- Office documents are opened by a bundled engine, not by another application.
  This rule used to read "never bundle, reference or mention any third-party
  office-suite binary"; it stopped being true before it was rewritten — a
  LibreOffice runtime has been bundled per platform for some time. See
  **The Office engine** above for what is bundled and why.
