# Changelog

## 3.2.3 — 2026-09-04

### AI assistant

- **Adding Magies Office to a coding CLI produced an entry that could never start.** The path written into the CLI's configuration pointed at a copy of the server that cannot load its own dependencies, so the agent came up with no Magies tools at all and nothing said why. Only installed copies were affected; the same setup made from a source checkout always worked

If a CLI was configured by an earlier version, add it again from Settings to replace the entry

## 3.2.2 — 2026-09-04

### Security

- The local API's health check no longer names the version to a caller without a token. It answers that it is alive to anyone, as it should — but with the API opened to the local network, that reply also told anyone on it exactly which build was running, and this application bundles several engines whose advisories can be looked up against one

### Printing

- Printing no longer asks the preview whether it is ready often enough to overwhelm it. On a busy machine that could make the print itself fail — a worse outcome than the blank page the check was added in 3.2.1 to prevent

## 3.2.1 — 2026-09-04

### AI assistant: the CLI agents work again

- **Codex, Gemini and Grok turns failed outright.** Each was launched with an option its CLI no longer accepts — or never did — so the turn ended with an error about arguments instead of doing anything. Every option is now the one the installed program documents
- Grok keeps its conversations per folder, and asking it to continue one that is not there ended the turn. It starts a new conversation instead
- All six agents offer their model tiers. The list shipped for Cursor had drifted badly — five of the seven models it offered no longer exist — and is now the one its CLI answers with; Antigravity gained the reasoning levels it has always accepted

### Printing

- **A long document could print as a single blank page**, on a machine busy enough that the preview had not finished rendering when the job was sent. The wait is no longer a guess about how long that takes: printing starts once every page is actually there

## 3.2.0 — 2026-09-04

### Security

- Reading a file is now something the main process grants, not a path the interface can ask for by name. Opening a document, dropping one on the window, choosing one from a dialog or from the recent list grants access to that file and nothing else. Any path could previously be read — and reading one also earned the right to overwrite it
- Choosing the external converter no longer reads the whole program into memory in order to select it. That read is also why a converter larger than 512 MB could not be chosen before

### Your work stays yours

- "Save and close" on an Office document now waits for the bytes to reach the disk before the tab closes. It used to close as soon as the save was asked for, so a save that had not finished took the edits with it
- A save that fails now says so. The tab kept showing the document as saved while the file on disk still held the old text, and closing it later asked nothing
- Closing the window or quitting now asks about documents with unsaved changes. Only closing a tab did
- Undoing back to the version you last saved marks the document as saved again, instead of leaving it changed forever
- Exporting an Office document to PDF no longer counts as saving it. The document itself was not written, so its unsaved changes survive — and the name offered in the dialog now ends in .pdf

### Printing

- Printing a PDF prints the PDF. It used to print the application window — the toolbar, the sidebar, the panels — and only the pages that happened to be on screen, so a sixty-page document came out as a few screens of interface. The keyboard shortcut, the toolbar button and the file menu now all do the same thing, and a failure is reported instead of nothing happening

### Office documents

- Opening a document that is already open focuses the tab holding it, instead of starting a second editor session that nothing then referenced. Each abandoned session kept a copy of the document in a temporary folder with nothing left able to remove it
- Opening several documents at once, when one of them fails to convert, no longer leaves the others' sessions behind
- Quitting now closes the editor and removes every temporary copy. Nothing did that before, so they accumulated
- When the assistant rewrites several documents in a row, every tab reloads. Only the last one did; the others were left pointing at an editor session that had already closed, with no way back

### Also fixed

- Turning automatic updates on starts the periodic check without needing a restart
- The text selection menu appears next to the text you selected on a scrolled page, rather than where that text would have been at the top of the document
- The badge on the heads-up display is centred

### Removed

- The freehand pen and the text-highlight palette are gone. Neither kept anything — the pen's stroke disappeared when the button came up, the palette highlighted nothing, and because neither marked the document as changed, closing the tab asked no questions. They come back when the annotations reach the file

### Under the hood

- lucide-react 1.27 and concurrently 10

## 3.1.0 — 2026-09-03

### macOS 13 is now required

- **This release needs macOS 13 (Ventura) or later.** The updated runtime follows Chromium in dropping macOS 12, so Monterey machines are not offered this update and stay on 3.0.2 — the update is withheld rather than installed and then unable to open

### Security

- An assistant reply is rendered as text and never as markup. A document can carry instructions written by whoever produced it, and a reply shaped by those instructions could previously restyle the panel or embed a frame; neither is possible now
- Links in an assistant reply open in your browser, and only for the schemes a browser would follow. Clicking one previously did nothing at all

### Under the hood

- Chromium and the desktop runtime updated to Electron 44, taking several months of upstream security fixes

## 3.0.2 — 2026-08-15

### macOS updates

- Publish one macOS update manifest containing both Intel and Apple Silicon packages, so automatic updates always select the native architecture

## 3.0.1 — 2026-08-15

### macOS client branding

- Scale the macOS application mark to the same visual footprint as standard system icons while keeping the artwork centred at every icon size
- Existing installs named `MagiesPdf.app` now migrate to `Magies Office.app` during an in-app update and relaunch from the renamed executable
- Refuse to overwrite an existing `Magies Office.app` during migration, leaving both installed applications intact

## 3.0.0 — 2026-08-07

### Office documents open in this window

- **Word, spreadsheets and slides now open as tabs in Magies Office itself**, not by handing the file to a separate program. Switching between a PDF and a document is a tab away, and the window keeps one toolbar rather than two
- The editor is an embedded **ONLYOFFICE Document Server 9.4.0** build, served locally over loopback. There is no server to run and no account to sign in to; the document never leaves the machine
- Create, open and **Save As** from the file menu, against the document open in the tab
- Full Western and CJK font lists, so a document composed elsewhere opens with the fonts it asked for
- Spreadsheets get pivot field areas, ranking and pivot charts, with headers that stay readable
- LibreOffice is still bundled and still renders PDF previews and format conversions — the embedded engine replaces the *editing* path, not the whole runtime

### PDF tools in a task pane

- Tools open as a **right-hand task pane or a compact dialog** instead of taking over the window, so the page stays in view while options are set
- One-shot and confirm-to-apply flows, with the resulting file size reported back
- **Aggressive compression** re-encodes images rather than only restreaming them, which is where the meaningful savings are. Standard compression stays lossless
- Create form fields, and replace text in place

### A quieter start centre

- Documents sit in the middle of the start centre, with the toolbox out of the way and a single search box
- New layered application mark, on macOS and Windows alike

### Packaging

- The engine's shared half is built once in CI and each platform's converter is prepared from its own package; packaging refuses outright rather than shipping an app that cannot open a document
- The unused PDF editor, 44 unused locales and the template gallery are left out of the package
- `pdfjs-dist` and `js-yaml` updated for high-severity advisories (GHSA-hq66-cqwq-w95j, GHSA-5p4m-2wfm-xmqj)

## 2.0.1 — 2026-08-01

### AI office agent

- OpenAI-compatible chat agent (OpenAI, DeepSeek, Qwen, Ollama, …) with per-tool approval, step budget, and encrypted API-key storage
- Grant a workspace folder; the agent runs local PDF tools and allow-listed Office operations without uploading full document bytes beyond approved plain-text previews
- Local MCP server for external agents, plus encrypted external MCP client configuration (stdio / Streamable HTTP) with approval on each external tool call
- Persist bounded, redacted task history for reuse

### Dual-mode controlled automation

- **Review vs unattended rules.** Folder automation can queue tasks for approval, or run unattended with an explicit allow-list of local Office tools only
- **Trusted document macros** (LibreOffice Basic in ODT/ODS/ODP copies) always require interactive approval and are never available to unattended rules
- Home screen exposes both manual Office editing and AI automation entry points

### Office automation actions

- Word: read content and tracked changes, accept/reject all changes, replace (plain or tracked), insert table/image, header/footer, comments
- Excel: read/write ranges, sort, auto-filter, format, conditional format, charts, pivot tables
- PowerPoint: read, replace text, add/duplicate/delete slides, insert image/table, speaker notes
- Templates: single and batch fill; batch convert to PDF; workspace scan and archive
- Writes always produce non-overwriting copies

### Correctness and docs

- Launch the bundled LibreOffice editor through macOS services so packaged apps start reliably
- Align Magies Office 2.x product narrative, unsigned first-launch steps, and in-app changelog with the dual-mode AI model

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
