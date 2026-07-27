# Repository Guidelines

## Project Structure & Module Organization

MagiesPdf is a Node.js 22+ Electron application with a React 19 renderer. Keep changes within the existing layers:

- `src/core/`: isomorphic TypeScript PDF engine and tool descriptors. It must not import DOM, React, Electron, or `@app/*`.
- `src/app/`: React UI, styles, localization, and static assets. The renderer receives tool metadata over IPC; do not import MuPDF, `pdf-lib`, or core tool implementations here.
- `src/node/`: worker and main-process entry points.
- `electron/`: CommonJS window, IPC, worker-pool, API, and updater code.
- `public/` and `build/`: runtime assets and packaging icons; `scripts/` contains build-time utilities.
- `mirror-worker/`: Cloudflare update-mirror worker.

Place tests beside the code as `*.test.ts` or `*.test.cjs`.

## Build, Test, and Development Commands

- `npm install`: install the locked dependencies.
- `npm run dev`: build/watch the worker, start Vite, and launch Electron.
- `npm test`: run TypeScript and Electron tests with `node:test`.
- `npm run test:coverage`: generate a `c8` coverage report.
- `npm run lint` / `npm run typecheck`: enforce ESLint and strict TypeScript rules.
- `npm run verify`: run lint, type checks, tests, and a production build; use before submitting.
- `npm run pack:mac-x64` (or the matching Windows/Linux command): create platform packages.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single quotes, and existing TypeScript/CommonJS patterns. Prefer `camelCase` for values and functions, `PascalCase` for React components and types, and `category.name` for tool IDs. Use `import type` for type-only imports. ESLint rejects unused imports, loose equality, and layer violations. Model user-facing failures as typed `ToolError` values with bilingual messages.

## Testing Guidelines

Follow RED → GREEN → REFACTOR: confirm a failing test before production changes. Use `node:assert/strict` with `describe`/`it`, cover normal behavior, edge cases, and errors, and keep changed-code coverage at 80% or higher. Run one test with `node --test --import tsx src/core/pageRange.test.ts`; build the node worker first for worker-pool tests.

## Commit & Pull Request Guidelines

Create a focused branch such as `feat/booklet-layout` or `fix/password-permissions`. Follow Conventional Commits, preferably scoped: `fix(pdf): copy save buffer`. Keep commits and PRs small. PRs should explain behavior and verification, link related issues, and include screenshots for UI changes. Never commit secrets, generated `dist*`, `release/`, or coverage output.
