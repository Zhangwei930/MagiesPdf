# Changelog

## 1.0.2 — 2026-07-27

### Security and reliability

- Sandbox Electron renderer and print windows, validate IPC callers, and restrict hidden-window network access
- Enforce REST input limits, safe file names, HTTPS for LAN access, asynchronous jobs, and cancellation
- Harden PDF action sanitisation and OOXML ZIP expansion limits
- Require explicit consent before downloading missing OCR language models

### Features and engineering

- Add local P12/PFX PDF certificate signing and signed-byte integrity verification
- Prefer the configured external converter for higher-fidelity Office import and export
- Expand the toolbox to 58 tools and add coverage gates, CI, and dependency maintenance
- Keep unsigned application update downloads and installation explicitly manual

### First-launch (unsigned builds)

- **macOS**: run `xattr -dr com.apple.quarantine /Applications/MagiesPdf.app`, or right-click → Open. Use `mac-x64` on Intel, `mac-arm64` on Apple Silicon.
- **Windows**: SmartScreen → More info → Run anyway
- **Linux AppImage**: `chmod +x` then run

## 1.0.1 — 2026-07-27

### Highlights

- **Settings** left-nav sections (appearance / files / converter / API / application)
- **What's New** in-app changelog dialog (no jump to GitHub release page)
- **Auto-update on by default**; dual-link feeds point to `Zhangwei930/MagiesPdf`
- Remove duplicate sidebar search bar (use Home / ⌘K)
- Shorter update error messages when a feed is offline

### First-launch (unsigned builds)

- **macOS**: run `xattr -dr com.apple.quarantine /Applications/MagiesPdf.app`, or right-click → Open. Use `mac-x64` on Intel, `mac-arm64` on Apple Silicon.
- **Windows**: SmartScreen → More info → Run anyway
- **Linux AppImage**: `chmod +x` then run

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

- **macOS**: after install, `xattr -dr com.apple.quarantine /Applications/MagiesPdf.app` — or right-click → Open
- **Windows**: SmartScreen → More info → Run anyway
- **Linux AppImage**: `chmod +x` then run

### Platforms (aligned with MagiesTerminal)

- **macOS**: DMG + ZIP · arm64, x64 (Intel)
- **Windows**: NSIS + portable + ZIP · x64, arm64
- **Linux**: AppImage, deb, rpm, pacman · x64, arm64

### Upgrade (dual-link)

- Settings → Check for updates (packaged builds only)
- Mainland China prefers `dl.magies.top/magiespdf/stable`; elsewhere prefers GitHub `Zhangwei930/MagiesPdf`
- Either feed falls back to the other on failure
