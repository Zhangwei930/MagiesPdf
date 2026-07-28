# Changelog

## 1.0.3 — 2026-07-28

### Open a PDF and edit it in place

- **New viewer** — open a PDF from Home and read it: page thumbnails, zoom, paging. Also reachable from the eye icon on any file you have picked or any PDF a tool produced.
- **Page editing** — rotate, delete and drag-reorder pages straight from the thumbnail rail.
- **Redact by dragging a box** — contents inside the box are permanently removed, not covered over.
- **Stamp by clicking** — pick a PNG/JPG seal or signature and click where it should go.
- **Fill forms on the page** — type into the fields drawn over the document instead of typing field names.
- Undo (10 steps), Save as…, and a **Choose a tool** handoff that carries your edits into any of the 58 tools.

### Correctness

- Clicked positions stay correct on rotated pages: renderers show a page with its rotation applied, while the drawing layer works in the unrotated page box, and the two are now reconciled.
- Encrypted PDFs can be opened with a password, which is reused for every edit. Because saving drops encryption, the viewer says so rather than letting it pass unnoticed.
- Form fields whose names contain `=` or a line break are skipped and reported, instead of being written to the wrong field.
- Updates now download automatically when enabled, and Restart to install works.

## 1.0.2 — 2026-07-27

### Security and completeness

- Sandbox the renderer and print windows; validate IPC origins and file names.
- Make unsigned update downloads and installation explicitly manual.
- Add strict REST input budgets, asynchronous jobs, cancellation, and HTTPS-only LAN access.
- Harden PDF sanitisation and OOXML ZIP expansion limits.
- Replace the vulnerable npm `xlsx` 0.18 package with maintained SheetJS 0.20.3 and audit shipped dependencies in CI.
- Require consent before OCR downloads missing language models.
- Add local P12/PFX PDF signing and signed-byte integrity verification.
- Prefer the configured external converter for high-fidelity Office import/export.
- Add coverage gates, mirror-worker tests, CI, and Dependabot.

## 1.0.1 — 2026-07-27

### Highlights

- **Settings** left-nav sections (appearance / files / converter / API / application)
- **What's New** in-app changelog dialog (no jump to GitHub release page)
- **Automatic update checks on by default**; downloads and installation remain manual
- Remove duplicate sidebar search bar (use Home / ⌘K)
- Shorter update error messages when a feed is offline

### First-launch (unsigned builds)

| OS | What to do |
| --- | --- |
| **macOS** | `xattr -dr com.apple.quarantine /Applications/MagiesPdf.app` |
| **Windows** | SmartScreen → More info → Run anyway |
| **Linux AppImage** | `chmod +x` then run |

## 1.0.0 — 2026-07-27

First public open-source release of **MagiesPdf**.

### Highlights

- **57 local PDF tools** across organize, convert, security, edit and advanced
- **Drawer sidebar** — click a category to expand tools
- **Pipeline** with built-in starters, save/load, JSON import/export
- **Batch** processing with recursive folder pick
- **Local REST API** (opt-in, bearer token, loopback by default)
- **Visible signatures** (draw / image / typed) — not certificate digital signatures
- **Brand icon** for macOS / Windows / Linux packages

### Explicit non-goals for this release

- No PDF **certificate** (PKCS#7 / X.509) signing or verification  
- No **code signing / notarization** of installers (open-source distribution)

### First-launch (unsigned builds)

| OS | What to do |
| --- | --- |
| **macOS** | After install: `xattr -dr com.apple.quarantine /Applications/MagiesPdf.app` — or right-click → **Open**. Use `mac-x64` on Intel, `mac-arm64` on Apple Silicon. |
| **Windows** | SmartScreen → **More info** → **Run anyway** |
| **Linux AppImage** | `chmod +x MagiesPdf-*-linux-*.AppImage` then run |

### Platforms (aligned with MagiesTerminal)

Unsigned installers (no Developer ID / notarization / Authenticode):

| Platform | Formats | Architectures |
| --- | --- | --- |
| **macOS** | DMG + ZIP | arm64, **x64 (Intel)** |
| **Windows** | NSIS + portable + ZIP | x64, arm64 (built separately) |
| **Linux** | AppImage + deb + rpm + pacman | x64, arm64 (built separately) |

Pack scripts (same pattern as MagiesTerminal):

```bash
npm run pack:mac          # both mac archs
npm run pack:mac-x64      # Intel Mac (this machine)
npm run pack:mac-arm64
npm run pack:win-x64
npm run pack:win-arm64
npm run pack:win          # x64 then arm64
npm run pack:linux-x64
npm run pack:linux-arm64
npm run pack:all
```

### Upgrade (dual-link, same as MagiesTerminal)

Settings → **检查更新** (packaged builds only).

| Region | Preferred feed | Fallback |
| --- | --- | --- |
| Mainland China (`zh-CN` / Asia/Shanghai…) | `https://dl.magies.top/magiespdf/stable` | GitHub `Zhangwei930/MagiesPdf` |
| Elsewhere | GitHub Releases | Cloudflare mirror |

Windows arm64 uses channel `latest-arm64` so it never clobbers x64 `latest.yml`.
Development runs report the current version without hitting a feed.
