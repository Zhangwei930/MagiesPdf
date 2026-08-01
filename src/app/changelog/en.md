# Changelog

## Unreleased

### Dual-mode controlled Office automation

- **Review vs unattended rules.** Folder automation can queue tasks for approval, or run unattended with an explicit allow-list of local Office tools only
- **Trusted document macros** (LibreOffice Basic in ODT/ODS/ODP copies) always require interactive approval and are never available to unattended rules
- Accept or reject all Word tracked changes through the controlled automation path, saving a new non-overwriting copy
- Home screen exposes both manual Office editing and AI automation entry points

## 2.0.0 — 2026-07-31

### Local Office workspace

- **Create, open and edit Word, Excel and PowerPoint files** from one desktop home screen, with recent documents, rename, remove and move-to-trash actions
- **LibreOffice 26.2.5 is included in the installer.** Customers install Magies Office once; no separate editor or online service is required
- Documents stay on the computer. Office-to-PDF and supported Office format conversions use the bundled local engine
- PDF remains a native Magies workspace, while Word, spreadsheets and slides open in the bundled desktop editor

### AI office assistant

- OpenAI-compatible model settings (including local providers such as Ollama)
- Agent can run the local PDF tool catalogue and allow-listed Office operations on a user-granted workspace folder, with per-call approval in chat
- Optional automation rules, task history, local MCP server, and encrypted external MCP client configuration

### Easier PDF work

- Creating a blank PDF now opens it directly in the editor, and text can be inserted by clicking the page
- Tool forms keep common options visible and move uncommon settings out of the way, with page-range shortcuts, grouped choices and real file pickers
- The home screen, document actions and editor entry points use a simpler office-style layout with fewer setup steps

### Installers and compatibility

- Bundle and verify the matching LibreOffice runtime in macOS Intel/Apple Silicon, Windows x64/ARM64 and Linux x64 packages
- Validate runtime architecture, version, open-source notice and native startup before uploading an installer
- Packages remain unsigned and free/open-source; macOS Gatekeeper or Windows SmartScreen may require manual confirmation on first launch
- Product UI name is **Magies Office**; release artefact filenames keep the `MagiesPdf-` prefix

## 1.0.4 — 2026-07-29

### From a toolbox to a document editor

- **Documents in tabs** — several PDFs open at once, each with its own edit history, zoom and reading position. Opening a file that is already open focuses its tab instead of opening it twice
- **Tools run on the document you have open** — pick a tool while a document is on screen and it runs on that document, with the result landing back in the page and `⌘Z` to undo it. No more find the file, drop it in, run, save, reopen the result
- **A ribbon across the top** — commands grouped by category replace the 268px tool tree down the left, which gives the document about 250px more width
- Tools that need more than one file still open their own page, but with the document already in the file list
- Closing a tab with unsaved changes asks: Save and close / Don't save / Cancel

### Reading

- **Continuous scrolling** — every page in one scrolling column, instead of clicking an arrow to see the next one
- **Fit width and fit page**, `⌘`-scroll (or a trackpad pinch) to zoom around the cursor, and hold Space to drag the page
- **Text can be selected and copied**, and `⌘F` searches the whole document with next / previous, a match count and wrap-around
- Text is no longer soft on a high-resolution display, and pages no longer flash blank when they redraw

### Opening and saving

- **Double-clicking a PDF in Finder or Explorer can open it in MagiesPdf.** It registers as an alternate handler, so it appears under Open With without displacing the reader you already use
- Dropping a file anywhere in the window opens it — no need to aim for the dashed box. On macOS, dropping onto the dock icon works too
- **`⌘S` overwrites the file you opened** instead of reopening a Save As dialog every time; `⌘⇧S` is Save As
- The keyboard is filled in: `⌘O` open, `⌘W` close, `⌘Z` / `⌘⇧Z` undo and redo, `⌘F` find, `⌘K` search tools, `⌘+` / `⌘-` zoom, `⌘0` actual size, `⌘1` fit width, `⌘2` fit page, plus the paging keys and Home / End
- Undo gained a matching redo

### Faster

- After an edit only the pages it actually changed are redrawn; the rest keep what they already had
- Faster to start: settings, the pipeline builder, batch processing and the signature pad now load when they are opened

### Correctness

- **An edit no longer moves the page out from under you** — rotate a page above where you are reading and your position stays put
- The first edit no longer makes the whole document visibly re-zoom
- Leaving a document no longer loses edits, so the "are you sure" prompt on navigation is gone; only closing a tab asks
- `⌘S` can only overwrite files this app itself opened; any other path is refused

## 1.0.3 — 2026-07-28

### Open a PDF and edit it in place

- **New viewer** — open a PDF from Home and read it: page thumbnails, zoom, paging. Also reachable from the eye icon on any file you picked or any PDF a tool produced
- **Page editing** — rotate, delete and drag-reorder pages straight from the thumbnail rail
- **Redact by dragging a box** — contents inside the box are permanently removed, not covered over
- **Stamp by clicking** — pick a PNG/JPG seal or signature and click where it should go
- **Fill forms on the page** — type into the fields drawn over the document instead of typing field names
- Undo (10 steps), Save as…, and a **Choose a tool** handoff that carries your edits into any of the 58 tools

### Correctness

- Clicked positions stay correct on rotated pages: renderers show a page with its rotation applied, while the drawing layer works in the unrotated page box, and the two are now reconciled
- Encrypted PDFs open with a password, which is reused for every edit. Because saving drops encryption, the viewer says so rather than letting it pass unnoticed
- Form fields whose names contain `=` or a line break are skipped and reported, instead of being written to the wrong field
- Updates download automatically when enabled, and Restart to install works

## 1.0.2 — 2026-07-27

### Security and reliability

- Sandbox Electron renderer and print windows, validate IPC callers, and restrict hidden-window network access
- Enforce REST input limits, safe file names, HTTPS for LAN access, asynchronous jobs, and cancellation
- Harden PDF action sanitisation and OOXML ZIP expansion limits
- Replace the vulnerable npm `xlsx` 0.18 package with maintained SheetJS 0.20.3 and audit shipped dependencies in CI
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
