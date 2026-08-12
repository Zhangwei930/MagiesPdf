# Contributing

Thanks for your interest in Magies Office / MagiesPdf.

## Before you start

1. Read the layer rules in [Claude.md](./Claude.md) (or [AGENTS.md](./AGENTS.md)).
2. Node.js **22+** is required.
3. Run `npm run verify` before opening a PR.

## Development

```bash
npm install
npm run prepare:engine -- --shared
npm run prepare:engine -- --platform=darwin --arch=arm64   # match your OS/arch
npm run dev
npm test
npm run verify
```

## How to contribute

- **Bug reports and feature ideas** — use [GitHub Issues](https://github.com/Zhangwei930/MagiesPdf/issues) with the templates.
- **Code** — open a focused PR from a branch named `feat/…`, `fix/…`, or `chore/…`.
- **Commit messages** — [Conventional Commits](https://www.conventionalcommits.org/), preferably scoped:
  `fix(pdf): copy save buffer out of the WASM heap`
- **Tests** — RED → GREEN → REFACTOR. New behaviour needs a failing test first.
  Keep changed-code coverage at the project thresholds (`npm run test:coverage`).

## Layer boundaries (non-negotiable)

| Layer | May import | Must not |
| --- | --- | --- |
| `src/core/` | isomorphic TS only | DOM, React, Electron, `@app/*` |
| `src/app/` | UI, catalogue *data* | `mupdf`, `pdf-lib`, `src/core/tools/*` implementations |
| `electron/` | main process, IPC, host | unvalidated renderer paths |

A PDF tool is one `ToolDescriptor` under `src/core/tools/<category>/` plus an
import in `src/core/tools/index.ts`. Names and errors are bilingual
(`{ zh, en }`).

## Security

Do not report exploitable vulnerabilities in public issues. See
[SECURITY.md](./SECURITY.md).

## Licence

By contributing you agree that your changes are licensed under the same terms
as the project: **AGPL-3.0-or-later**.
