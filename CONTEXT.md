# HiBook context

## Current state

Commits 1–2 are complete. The project now has a conventional client-only Vite/Solid 2 application baseline plus a standalone normalized notebook model with Unicode naming rules, malformed-snapshot diagnostics, pure structural commands, and focused model tests. No sample notebook, editor, compiler worker, runtime, cache, Markdown pipeline, persistence, or model-to-UI integration exists yet; Commit 3 is next.

## Architecture decisions

- Keep `index.html` and `src/main.tsx` as the conventional Vite SPA entry points. Framework server modes are out of scope.
- Use Solid 2 APIs and semantics. Future reactive code must use the Solid 2 effect shape, settled lifecycle, boxed function signal values, and synchronous `peek()` reads described in `PROMPT.md`.
- Keep serialized notebook documents separate from runtime signals, compiler state, and arbitrary JavaScript values.
- Use CSS Modules for component-local structure and global custom properties for theme semantics. The layout remains flat and full-width independently of color choices.
- Add dependencies only in the commit that uses them. CodeMirror, marked, DOMPurify, IndexedDB helpers, Oxc, and worker/compiler implementation packages are intentionally absent from the baseline.
- Future notebook execution is an explicitly unsandboxed boundary: page-context execution must be treated as suitable only for trusted notebook code and must never be presented as safe isolation.

## Notebook model decisions

- Persisted state is `NotebookDocument { rootId, cells }`, where each `Cell` owns serializable data and an ordered `children` ID array. IDs are permanent and location-independent; parent relationships are derived rather than stored.
- The public model API is `createNotebook`, `appendChild`, `insertSibling`, `update`, `move`, `remove`, and `parentOf` in `src/model/commands.ts`, plus `validateNotebook` in `src/model/validate.ts`. Mutations return a typed `CommandResult`; lookup returns `ParentLookupResult`; malformed imports return typed validation diagnostics rather than throwing.
- New cells use `CellInput`, which excludes structural children. Commands create leaves, own all newly accepted arrays and deeply clone metadata, preserve source verbatim, and copy only cells and child arrays changed by the operation.
- The root cannot be removed, moved, or used as a sibling reference. Removal deletes the complete selected subtree. A move preserves subtree IDs and data, rejects self/descendant targets, and accepts either `{ type: \"child\", parentId, index? }` or `{ type: \"sibling\", referenceId, position }`. A same-parent child index addresses the destination child list after removing the moving cell.
- Cell names use Unicode ECMAScript identifier syntax, with `$`, `_`, join controls, and Unicode identifier characters supported. Handle fields `value`, `children`, `id`, `name`, `kind`, `text`, `update`, `append`, `remove`, and `replaceChildren` are reserved. Uniqueness is sibling-scoped; ancestor, descendant, and unrelated branches may reuse a name.
- Omitted create names come from readable adjective/noun pairs, probe deterministically from an injectable random source, avoid sibling collisions, and use numeric suffixes only after exhausting the base pairs. Hard-coded notebook data must still supply explicit deterministic names.
- Whole-document validation checks root/key/identity consistency, cell data shapes and serializable metadata, child references, duplicate children and declared IDs, parent cardinality, reachability, cycles, name validity/reservations, and sibling collisions. Command errors and validation diagnostics use stable string codes.

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

Final Commit 2 validation on 2026-09-04:

- `npm test -- --run` passed 3 test files and 22 tests.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run build` passed with unchanged baseline output sizes: `index.html` at 0.50 kB, CSS at 1.62 kB (0.84 kB gzip), and JavaScript at 29.06 kB (11.47 kB gzip).
- The online `npm audit --omit=dev` endpoint timed out twice; the immediate cache-backed `npm audit --omit=dev --offline` retry found 0 vulnerabilities.
- A throwaway `tsx` smoke scenario created `root`, `analysis`, and `note`; moved `note` under `analysis`; verified its parent lookup; removed the `analysis` subtree; and produced a normalized root-only document.
- No browser test was required because Commit 2 adds no visible behavior.

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
