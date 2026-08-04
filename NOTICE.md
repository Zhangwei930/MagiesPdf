# Third-party notices

MagiesPdf is licensed under the GNU Affero General Public License, version 3 or
later. It redistributes the components below. Where a component is under a
copyleft licence, that is the reason this project is under the same one.

Each entry says what the component is, under what licence it is redistributed,
where its source can be obtained, and — where it applies — what was changed.

---

## ONLYOFFICE Document Server

**Version 9.4.0** · **AGPL-3.0-only** · Ascensio System SIA

Source: <https://github.com/ONLYOFFICE/DocumentServer>
Binaries as redistributed here came from
<https://download.onlyoffice.com/install/documentserver/linux/onlyoffice-documentserver_amd64.deb>

Two builds of the same engine ship, unmodified, under `resources/onlyoffice`:

- `editors/` — the desktop build, from the ONLYOFFICE Desktop Editors package.
  The document converter runs it to render PDFs.
- `web/` — the Document Server build. This is what the embedded editor loads.

### Modifications

The engine's own files are redistributed byte for byte. What differs is what
this application serves in place of two things a document server would provide,
and one transformation applied on the way out. All of it lives in
`electron/office/` and is part of this project's source:

1. **`web-apps/vendor/socketio/socket.io.min.js` is answered with a local
   stand-in.** There is no document server to connect to; the stand-in delivers
   the same messages a server would, from this machine. The file on disk is
   untouched — the substitution happens when the request is served.
2. **`themes.json`, `plugins.json` and the service worker are answered as
   empty.** These are a server's configuration, and there is no server.
3. **Fonts are obfuscated as they are served.** The engine expects the ODTTF
   obfuscation a document server's fonts are stored under and undoes it on
   receipt, so serving a plain font file would corrupt it. The font files
   themselves are stored and redistributed unmodified.
4. **`api.js` is served from the `api.js.tpl` that ships with it**, unrendered.
   The template is written to skip its one substitution when left alone.

### Trademarks

ONLYOFFICE is a trademark of Ascensio System SIA. This project is not
affiliated with, endorsed by, or sponsored by Ascensio System SIA. The name is
used only to identify the component, and the editor displays its own branding
where the engine puts it.

---

## Fonts

### ONLYOFFICE core fonts

**Various open licences** — see `core-fonts/README.md` and the licence files
alongside each family.
Source: <https://github.com/ONLYOFFICE/core-fonts>

Redistributed unmodified under `resources/onlyoffice/web/fonts`. The families
include Liberation, Carlito, Caladea, DejaVu, Open Sans, FreeFont, WenQuanYi
Zen Hei, AR PL UKai, Nanum, Takao and the Noto script families.

### Noto Sans CJK

**SIL Open Font License 1.1** · Google
Source: <https://github.com/notofonts/noto-cjk>
Licence text: `resources/onlyoffice/web/fonts/LICENSE-NotoSansCJK.txt`

Redistributed unmodified. It is here because documents written on Linux
commonly name it outright, and without it their text has no glyphs.

**The font manifest is generated, not redistributed.**
`web/sdkjs/common/AllFonts.js` is produced by `scripts/onlyofficeFonts.mjs` in
this repository, from the fonts above.

---

## LibreOffice

**MPL-2.0** · The Document Foundation
Source: <https://www.libreoffice.org/download/download/>

A matching runtime is bundled per platform and launched as a separate program.
Redistributed unmodified.

---

## MuPDF

**AGPL-3.0-or-later** · Artifex Software
Source: <https://mupdf.com/releases>

Used through `mupdf` on npm. Redistributed unmodified. This is the component
that makes AGPL the only licence this project can carry.

---

## Obtaining source

The source for this application is at
<https://github.com/Zhangwei930/MagiesPdf>. The source for each component above
is at the address given in its entry. Where a licence entitles you to the
corresponding source of a binary shipped here, these are the addresses it is
available from.
