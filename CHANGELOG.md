# Changelog

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
