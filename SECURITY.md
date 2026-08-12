# Security policy

## Supported versions

Security fixes are applied to the **latest released version** on
[GitHub Releases](https://github.com/Zhangwei930/MagiesPdf/releases).
Older tags are not back-ported unless a release is still widely distributed
and the issue is severe.

## What Magies Office assumes

Magies Office is a **local-first** desktop app:

- Documents are processed on the machine; they are not uploaded to Magies servers.
- Optional network use is limited to update checks, user-approved OCR language
  packs, and AI / MCP endpoints **you** configure.
- Installers are currently **unsigned**. Treat downloads as you would any
  open-source binary: prefer the official GitHub Release (or the documented
  mainland China mirror that proxies that same release).

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems that could
be exploited (path traversal in local API, privilege issues, secret leakage,
unsigned-update bypasses, and similar).

Instead, email:

**470059464@qq.com**

Include:

1. Affected version (or commit) and platform / arch
2. Impact (what an attacker can do)
3. Steps to reproduce, or a minimal PoC
4. Whether you plan a public disclosure date

You should receive an acknowledgement within a few days. If the report is
confirmed, we aim to ship a fix in the next patch release when practical.

## Local REST API and MCP

The local API and MCP server are **off by default**. When enabled they bind to
loopback unless you explicitly opt into LAN mode (HTTPS with your own certs).
Treat the bearer token like a password on that machine.

## Scope notes

- Magies Office does not claim OS-level certificate trust or revocation checks
  for PDF signature inspection beyond what is documented in the tool itself.
- Bundled third-party runtimes (ONLYOFFICE, LibreOffice, MuPDF, etc.) follow
  their own upstream security processes; see [NOTICE.md](./NOTICE.md).
