# HiBook context

## Current state

Commit 1 establishes a conventional client-only Vite SPA using Solid 2, strict TypeScript, Vitest, ESLint, CSS Modules, and global semantic theme tokens. The rendered application is an accessible, full-screen, full-width status shell. No notebook model, sample notebook, editor, compiler worker, runtime, cache, Markdown pipeline, or persistence exists yet.

## Architecture decisions

- Keep `index.html` and `src/main.tsx` as the conventional Vite SPA entry points. Framework server modes are out of scope.
- Use Solid 2 APIs and semantics. Future reactive code must use the Solid 2 effect shape, settled lifecycle, boxed function signal values, and synchronous `peek()` reads described in `PROMPT.md`.
- Keep serialized notebook documents separate from runtime signals, compiler state, and arbitrary JavaScript values.
- Use CSS Modules for component-local structure and global custom properties for theme semantics. The layout remains flat and full-width independently of color choices.
- Add dependencies only in the commit that uses them. CodeMirror, marked, DOMPurify, IndexedDB helpers, Oxc, and worker/compiler implementation packages are intentionally absent from the baseline.
- Future notebook execution is an explicitly unsandboxed boundary: page-context execution must be treated as suitable only for trusted notebook code and must never be presented as safe isolation.

## Package decisions

All direct dependency versions are exact in `package.json`; the lockfile captures transitive versions.

| Package | Version | Decision |
| --- | --- | --- |
| `solid-js` | `2.0.0-rc.6` | Solid 2 is required; npm stable remains Solid 1.x. |
| `@solidjs/web` | `2.0.0-rc.6` | Solid 2 browser renderer, aligned exactly with the core release candidate. |
| `@solidjs/vite-plugin` | `3.0.0-next.38` | Official renamed plugin release whose peer range supports Solid 2 RC and Vite 8. |
| `typescript` | `5.9.3` | Pinned to the requested 5.9 line. |
| `vite` / `vitest` | `8.2.2` / `5.0.0` | Compatible current releases sharing the supported Node baseline. |
| `eslint` / `typescript-eslint` | `10.9.1` / `8.69.0` | Current compatible flat-config lint stack for TypeScript and TSX. |

Node `22.13.0` or newer on an even-numbered supported release line is required by the selected Vite, Vitest, plugin, and ESLint engine ranges.

## Validation

Run these commands for meaningful changes:

```sh
npm test -- --run
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

Final baseline validation on 2026-09-04:

- `npm test -- --run` passed with no test files.
- `npm run typecheck` passed after setting the Solid 2 web JSX source to `@solidjs/web`.
- `npm run lint` passed.
- `npm run build` passed. Vite emitted `index.html` at 0.50 kB, CSS at 1.62 kB (0.84 kB gzip), and JavaScript at 29.06 kB (11.47 kB gzip).
- `npm audit --omit=dev` found 0 vulnerabilities.
- Agent-browser verification passed at desktop and mobile sizes: at 1440 × 900 the main element width was exactly 1440 px; at 390 × 844 the main and document scroll widths were exactly 390 px. The semantic snapshot contained the main region, header, heading, and status text. There were no page errors; the console contained only Vite connection debug messages.

## Performance measurements

Record measured values here with device, browser, build mode, fixture/revision, and date. Blank results mean no measurement has been taken.

| Scenario | Environment | Result | Date |
| --- | --- | --- | --- |
| Initial structure and prose visible |  |  |  |
| Uncached edit to first visible output |  |  |  |
| Uncached edit to semantic diagnostics |  |  |  |
| Exact-revision cached reopen to output |  |  |  |
| Exact-revision cached worker constructions |  |  |  |
| Large-notebook interaction |  |  |  |
