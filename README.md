# Magies Office

Local-first desktop workspace for **Word, Excel, PowerPoint and PDF**.
Merge, convert, protect and automate — **everything runs on your own machine**.
No upload, no account, no telemetry.

The app product name is **Magies Office** (`package.json` / installers). The
source repository remains [Zhangwei930/MagiesPdf](https://github.com/Zhangwei930/MagiesPdf);
release artefacts keep the `MagiesPdf-…` file prefix for continuity.

Built with Electron + React 19 + TypeScript. Supported packages:

| Platform | Architectures | Notes |
| --- | --- | --- |
| macOS | Intel + Apple Silicon | DMG + zip |
| Windows | x64 + ARM64 | NSIS, portable, zip |
| Linux | x64 | AppImage + deb |

Each package **bundles a matching LibreOffice runtime**. You do not need a
separate Office install. **Linux ARM64 is not published** (no official LO
desktop runtime for that target).

**Version 2.0.0** — see [CHANGELOG.md](./CHANGELOG.md) ·
[Releases](https://github.com/Zhangwei930/MagiesPdf/releases).

Installers are **unsigned** (open source), same policy as MagiesTerminal.
PDF certificate signing is separate: P12/PFX material is processed locally and
is never saved by Magies Office.

---

## Three ways to work

| Mode | What it is | Where it runs |
| --- | --- | --- |
| **PDF workspace** | Open PDFs in tabs; read, redact, stamp, fill forms, run any of the 58 tools, undo | Inside Magies Office |
| **Manual Office** | Create/open Word, Excel, PowerPoint (and ODF); edit in the bundled editor | Bundled LibreOffice (launched from the app) |
| **AI automation** | Natural-language tasks on a folder you grant; optional review queue or unattended rules | Local tools + your OpenAI-compatible model |

**AI safety (short version):** tool calls need approval in interactive chat.
Folder rules can be **review** (queue for you) or **unattended** (only the local
Office tools you allow). Document macros always need interactive approval, only
run trusted document-scoped LibreOffice Basic in ODT/ODS/ODP copies, and **never**
run in unattended rules. Writes save new copies — sources are not overwritten.

Configure the model under **Settings → AI** (OpenAI, DeepSeek, Qwen, Ollama, …).
Documents stay on disk; the model only receives your prompt, tool summaries, and
limited plain-text previews you approve.

---

## First launch (unsigned builds)

> **macOS:** Not code-signed or notarized. After dragging into Applications:
>
> ```bash
> xattr -dr com.apple.quarantine "/Applications/Magies Office.app"
> ```
>
> Or right-click → **Open** → confirm. Use **`mac-x64`** on Intel,
> **`mac-arm64`** on Apple Silicon.

> **Windows:** SmartScreen may say “Windows protected your PC”. Choose
> **More info** → **Run anyway**. Prefer `MagiesPdf-*-win-x64.exe` (or arm64
> on Snapdragon / ARM PCs). Desktop shortcut name is **Magies Office**.

> **Linux (AppImage):**
>
> ```bash
> chmod +x MagiesPdf-*-linux-*.AppImage
> ./MagiesPdf-*-linux-*.AppImage
> ```
>
> `.deb` installs with your package manager as usual.

### After open — 60-second checklist

1. Home shows **Built-in Office engine is ready** (green). If missing, reinstall.
2. **PDF:** New PDF or drop a file → edit in the viewer → `⌘S` / `Ctrl+S`.
3. **Office:** New Document / Spreadsheet / Presentation → edits open in the bundled editor.
4. **AI (optional):** Settings → AI → set base URL + model → grant an office folder in the AI panel → approve the first tool call.

---

## Package artefacts

| OS | Artefacts | Build command |
| --- | --- | --- |
| macOS | Intel/Apple Silicon DMG and zip | `npm run pack:mac-x64` / `pack:mac-arm64` |
| Windows | x64/ARM64 NSIS, portable exe and zip | `npm run pack:win-x64` / `pack:win-arm64` |
| Linux | x64 AppImage and deb | `npm run pack:linux-x64` |

```bash
npm run pack:mac-x64    # Intel (x86_64)
npm run pack:win-x64
npm run pack:linux-x64
# Release CI builds the five supported OS/arch targets on native runners.
```

---

## Why local-only

Most online PDF tools ask you to upload the document first. For a contract, a
payslip or a passport scan that is the wrong trade. Magies Office does the same
work on your desk; the file never leaves the machine.

Network access is limited to:

- optional **dual-link** update checks (GitHub Releases overseas;
  `dl.magies.top/magiespdf/stable` in mainland China, with fallback)
- user-approved OCR language-model downloads
- optional AI provider calls you configure (prompt + approved previews only)

Unsigned update packages are never downloaded or installed without separate
confirmation.

---

## PDF tools (58)

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
| Word / Excel / PowerPoint → PDF | Bundled LibreOffice path + optional external converter |

### Security
| Tool | What it does |
| --- | --- |
| Add / Remove password | AES-256 and related encryption |
| Watermark | Translucent text, CJK-capable |
| Add signature | Drawn / image / typed visible signature |
| Certificate digital signature | Local P12/PFX PKCS#7 signing |
| Inspect signatures | Signed-byte integrity and certificate details; OS trust/revocation is not claimed |
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

## Local REST API & MCP

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

With the local API enabled you can also expose tools to external agents via
**Settings → MCP** (stdio config for Codex, Claude Code, …). External MCP
servers you connect to still require approval per tool call.

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
npm run pack:mac-x64 / pack:win-x64 / pack:linux-x64
```

### If binary downloads fail

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm install
```

## Architecture

```
electron/            main process — window, IPC, worker pool, host, API, updater,
                     bundled LibreOffice launch, AI agent, Office UNO automation
src/core/            isomorphic PDF engine — no DOM, no Electron, no React
src/node/            worker + core entry for main-process tools
src/app/             React renderer — metadata only, never imports mupdf/pdf-lib
```

**A tool is one descriptor.** Card grid, options form, ⌘K, pipeline palette and REST
routes all derive from it.

**The renderer cannot execute tools.** It receives catalogue *data* over IPC so
MuPDF WASM never lands in the UI bundle.

**Two PDF engines.** MuPDF for decrypt/encrypt/render/text; pdf-lib for composition
and drawing. `src/core/pdf/document.ts` bridges them and always copies save buffers
out of the WASM heap.

**Office.** Packaged clients ship a verified LibreOffice runtime for create/open/edit
and high-fidelity convert. Optional external CLI converter in Settings is never
named or bundled as a third-party suite.

**AI.** OpenAI-compatible client + allow-listed PDF and Office tools; folder rules
with review vs unattended modes and a hard ban on unattended macros.

## Licence

AGPL-3.0-or-later. Builds on [MuPDF](https://mupdf.com/) (AGPL-3.0),
[pdf-lib](https://pdf-lib.js.org/) (MIT), [PDF.js](https://mozilla.github.io/pdf.js/)
(Apache-2.0) and a bundled [LibreOffice](https://www.libreoffice.org/) runtime
(see the installer notice).
