# MagiesPdf

A cross-platform desktop PDF toolbox. Merge, split, convert, protect and automate —
**everything runs on your own machine**. No upload, no account, no telemetry.

Built with Electron + React 19 + TypeScript, for macOS, Windows and Linux. Every
supported desktop client provides two Office modes: manual editing in the
built-in LibreOffice editor, and AI automation for approved workspace files.

Supported packaged clients are macOS Intel/Apple Silicon, Windows x64/ARM64,
and Linux x64. Each package carries its matching LibreOffice runtime, so users
do not need a separate Office installation. Linux ARM64 is intentionally not
published because LibreOffice does not provide the required official desktop
runtime for that target.

AI automation covers Word, Excel, PowerPoint, OpenDocument and PDF workflows,
including batch processing. High-risk document macros always require an
interactive approval, are limited to trusted document-scoped LibreOffice Basic
macros in ODT/ODS/ODP copies, and can never run in unattended rules.

**Version 1.0.2** — see [CHANGELOG.md](./CHANGELOG.md) ·
[Download](https://github.com/Zhangwei930/MagiesPdf/releases/tag/v1.0.2).

Installers are **unsigned** (open source), same policy as MagiesTerminal.
PDF certificate signing is separate: P12/PFX material is processed locally and
is never saved by MagiesPdf.

### First-launch notes (unsigned builds)

> **macOS:** Releases are not code-signed or notarized. Gatekeeper will block
> the first open. After dragging the app into Applications, run:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/MagiesPdf.app
> ```
>
> Or right-click the app → **Open** → confirm. Intel Macs need the **`mac-x64`**
> build; Apple Silicon needs **`mac-arm64`**.

> **Windows:** SmartScreen may say “Windows protected your PC”. Choose
> **More info** → **Run anyway**. Prefer `MagiesPdf-*-win-x64.exe` (or arm64
> on Snapdragon / ARM PCs).

> **Linux (AppImage):** make executable then run:
>
> ```bash
> chmod +x MagiesPdf-*-linux-*.AppImage
> ./MagiesPdf-*-linux-*.AppImage
> ```
>
> `.deb` installs with your package manager as usual.

### Package artefacts (same family as MagiesTerminal)

| OS | Artefacts | Build command |
| --- | --- | --- |
| macOS | Intel/Apple Silicon DMG and zip | `npm run pack:mac-x64` / `pack:mac-arm64` |
| Windows | x64/ARM64 NSIS, portable exe and zip | `npm run pack:win-x64` / `pack:win-arm64` |
| Linux | x64 AppImage and deb | `npm run pack:linux-x64` |

```bash
npm run pack:mac-x64    # Intel (x86_64)
npm run pack:win-x64
npm run pack:linux-x64
# The release workflow builds the five supported OS/architecture targets
# on their native GitHub Actions runners.
```

---

## Why local-only

Most online PDF tools ask you to upload the document first. For a contract, a payslip
or a scan of your passport that is the wrong trade. MagiesPdf does the same work on
your desk, with the file never leaving the machine.

Network access is limited to an optional **dual-link** update check and
user-approved OCR model downloads. Updates use GitHub Releases overseas and the
Cloudflare mirror `dl.magies.top/magiespdf/stable` in mainland China, with
automatic fallback. Unsigned packages are never downloaded or installed without
separate user confirmation. OCR accesses jsDelivr only when a selected language
model is missing and the user enables the download option.

## Tools (58)

### Organize
| Tool | What it does |
| --- | --- |
| Merge PDF | Combine files in any order |
| Split PDF | By page count, cut points, equal parts, or file size |
| Extract / Remove Pages | Keep or drop pages with full range syntax |
| Reorder | Custom order, reverse, odd/even, duplex repair, booklet |
| Rotate | 90° / 180° / 270° |
| Split by chapters | Cut on outline / heading changes |
| Remove blank pages | Drop empty pages |
| Crop / Scale | Geometry adjustments |
| N-up / Single page | Impose or explode pages |
| Overlay PDF | Stamp one PDF onto another |

### Convert
| Tool | What it does |
| --- | --- |
| PDF ↔ Image | Render pages; build PDF from PNG/JPG |
| PDF → Text / Markdown / HTML / CSV | Extract structured text |
| PDF → Word / Excel / PowerPoint | Editable exports; optional external high-fidelity path |
| Markdown / HTML / Text / CSV → PDF | Chromium `printToPDF` layout |
| Word / Excel / PowerPoint → PDF | Built-in path + optional external converter |

### Security
| Tool | What it does |
| --- | --- |
| Add / Remove password | AES-256 and related encryption |
| Watermark | Translucent text, CJK-capable |
| Add signature | Drawn / image / typed visible signature |
| Certificate digital signature | Local P12/PFX PKCS#7 signing |
| Inspect signatures | Check signed-byte integrity and list certificate details; OS trust/revocation is not claimed |
| Redact | Permanent keyword blackout |
| Sanitize / Flatten | Strip risky objects; bake form values |
| Metadata | Edit or strip |

### Edit
| Tool | What it does |
| --- | --- |
| Create blank PDF | New multi-page empty document |
| Compress / Repair / OCR | Size, fix, recognise text |
| Grayscale | Rasterise selected pages to greyscale |
| Page numbers / Header & footer | Numbering and running titles |
| Stamp | Image seals and logos |
| Attachments / Bookmarks | Embed files; rebuild outlines |
| Compare / Fill form / Info | Diff text; fill fields; inspect |

### Advanced
| Tool | What it does |
| --- | --- |
| Pipeline | Chain tools with visual editor, presets, JSON import/export |
| Batch | Run one tool on many files; add whole folders (recursive) |

Every tool that reads a PDF accepts encrypted sources and a password parameter.

### Page selection syntax

```
1,3,5       individual pages, in the order written
2-8         a span
8-2         a reversed span
8-    -3    open-ended
N           the last page (also inside a span: 8-N)
1-10/3      every 3rd page of the span
all  odd  even  first  last
```

---

## Local REST API

Off by default. Enable in **Settings → Local REST API**, set a bearer token, then:

```bash
# Health (no auth)
curl http://127.0.0.1:8737/v1/health

# List tools
curl -H "Authorization: Bearer YOUR_TOKEN" http://127.0.0.1:8737/v1/tools

# Run a tool
curl -X POST http://127.0.0.1:8737/v1/tools/organize.rotate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"files":[{"name":"a.pdf","bytesBase64":"..."}],"params":{"degrees":"90"}}'
```

Default bind is loopback only; LAN binding is an explicit opt-in.
LAN mode requires absolute paths to a PEM certificate and private key and serves
HTTPS only. Add `?async=true` to a tool POST to receive a job ID; poll
`GET /v1/jobs/<id>` or cancel with `DELETE /v1/jobs/<id>`.

---

## Development

Requires Node.js 22+.

```bash
npm install
npm run dev          # worker bundle + Vite + Electron
npm run verify       # lint + typecheck + tests + build
npm run test:coverage # core/Electron coverage with enforced thresholds
```

```bash
npm test
node --test --import tsx src/core/pageRange.test.ts
npm run pack:mac / pack:win / pack:linux
```

### If binary downloads fail

Set the official Electron environment variables before installing:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm install
```

## Architecture

```
electron/            main process — window, IPC, worker pool, host (printToPDF), API, updater
src/core/            isomorphic engine — no DOM, no Electron, no React
src/node/            worker + core entry for main-process tools
src/app/             React renderer — metadata only, never imports mupdf/pdf-lib
```

**A tool is one descriptor.** Card grid, options form, ⌘K, pipeline palette and REST
routes all derive from it.

**The renderer cannot execute tools.** It receives catalogue *data* over IPC so
MuPDF WASM never lands in the UI bundle (kept under ~300 KB).

**Two PDF engines.** MuPDF for decrypt/encrypt/render/text; pdf-lib for composition
and drawing. `src/core/pdf/document.ts` bridges them and always copies save buffers
out of the WASM heap.

**Office conversion.** Built-in HTML → Chromium `printToPDF`. Optional external
command-line converter in Settings (no third-party product is bundled or named).

## Licence

AGPL-3.0-or-later. Builds on [MuPDF](https://mupdf.com/) (AGPL-3.0),
[pdf-lib](https://pdf-lib.js.org/) (MIT) and [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0).
