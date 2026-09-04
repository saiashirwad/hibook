# HiBook context

## Current state

Commits 1–6 are complete. The app now opens a deterministic Tiny Commerce notebook as a full-width recursive outliner, prepares it through one lazy fast worker, executes six cells reactively, and exposes collapse, zoom, breadcrumbs, independent disclosures, runtime state, provisional types, and atomic inline rename. Markdown output remains escaped plain text until Commit 7. No semantic worker, virtual TypeScript project, persistent compiler cache, rendered Markdown pipeline, persistence, or editor integration exists yet.

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

## Static runtime analysis decisions

- `src/runtime/resolve-path.ts` is the single structural definition of notebook path meaning. Origins are resolved relative to the analyzed cell (`root`, `parent`, or `self`); direct named hops and explicit `.children` hops traverse the same ordered child IDs; only a terminal `.value` is an executable dependency read.
- Path outcomes are stable typed results: resolved targets carry permanent `CellId`s, while missing, ambiguous, dynamic, and invalid outcomes carry source spans and never add guessed edges. Repeated references to the same child ID remain resolvable, but distinct same-name children or multiple parents in malformed snapshots are ambiguous.
- `src/runtime/analyze-dependencies.ts` owns the TypeScript compiler API import. It analyzes `$` and `md` callbacks without executing code, preserves half-open source offsets and explicit `$<Type>` text, respects callback lexical shadowing including switch `CaseBlock` scope, reports computed or aliased handles, de-duplicates resolved target IDs, and leaves source unchanged. Scalar handle metadata and chains beyond runtime `.value` data are not misclassified as handle aliases or dependency paths; nested `.value` reads stop at the first runtime-value boundary. Text cells have no executable dependencies, and syntax/path failures remain per-cell issues.
- Graph order is root-first document traversal followed by any remaining cell keys. Dependency and dependent maps preserve that order; topological layers batch ready acyclic cells; strongly connected groups include self-cycles; cells downstream of cycles are reported separately without blocking unrelated branches. Downstream closure includes known changed IDs and every transitive dependent in document order.

## Headless execution decisions

- `src/runtime/registry.ts` owns live per-cell state in a regular `Map<CellId, CellRuntime>`. Each entry owns boxed Solid signal values plus synchronous imperative peek state; successful, failed, and cycle resolutions advance a monotonic version. Registry synchronization publishes text source and explicitly disposes entries removed from the serialized document.
- `src/runtime/read-handles.ts` derives frozen readonly handles from normalized structure. Direct named children and the explicit `children` form share handle identities, while `value` reads the current registry value. Runtime handles expose no structural mutation API and are never stored in `NotebookDocument`.
- `src/compiler/fast-prepare.ts` owns syntax validation and transpilation for execution. Its worker-local cache reuses output only for byte-identical cell ID, kind, and source while every document revision rebuilds dependency/path meaning. Fast output carries provisional `string`, explicit annotation, `unknown`, invalid, and cycle type/status data plus serialized graph data and measured preparation counters.
- `src/compiler/fast-worker.ts` is the dedicated worker boundary. `src/compiler/coordinator.ts` constructs it only on the first uncached request, coalesces exact in-flight revisions, retains completed exact revisions in memory, rejects mismatched responses, prevents stale responses from becoming current, and provides the 120 ms replaceable/cancellable execution scheduler. Semantic tooling and IndexedDB caching remain deferred to commits 8 and 9.
- `src/runtime/execute.ts` consumes an exact `PreparedNotebook` or an explicitly injected notebook preparer. It has no synchronous TypeScript preparation fallback and no static dependency on TypeScript or the dependency analyzer; worker preparation does not alter transaction ordering, errors, or the intentionally unsandboxed `Function` execution boundary.
- Notebook programs currently execute with `Function` in the page realm. This is intentionally unsandboxed and suitable only for trusted notebook code; preparation in a worker will not make execution a security boundary.

## Reactive outliner decisions

- `src/demo/notebook.ts` is the deterministic Tiny Commerce fixture. Every cell has an explicit stable ID and programmatic name; its sources exercise direct, explicit `.children`, and expected-parent paths, while a separate executable branch remains available for later compiler-reuse demonstrations.
- The App-owned notebook controller keeps serialized document, prepared compiler output, and application errors in separate boxed signals. It owns one lazy fast-preparation coordinator and one runtime registry, pre-creates initial cell runtimes in component setup, starts synchronization, preparation, and execution from `onSettled`, rejects stale completion writes by run and revision, and disposes worker/runtime state with the component.
- Rename remains a model `update` command and changes only the programmatic name. Successful structural name changes prepare the new exact revision and rerun the whole document so newly resolving or missing paths cannot be skipped; invalid changes stay atomic and expose the typed command message inline.
- Collapse, selection, zoom, disclosures, and rename draft/error state are transient, ID-keyed UI state. Breadcrumbs are derived from normalized structure rather than persisted metadata.
- Commit 6 renders Markdown callback output only as plain text and uses a deliberately small defensive JavaScript value formatter. CodeMirror, marked/DOMPurify rendering, semantic TypeScript, and persistent caching remain owned by later commits.

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

Final Commit 3 validation on 2026-09-04:

- `npm test -- --run` passed 6 test files and 37 tests; the runtime-specific subset passed 3 files and 15 tests.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run build` passed.
- The offline production audit found 0 vulnerabilities.
- A throwaway `tsx` smoke scenario built `root`, `products`, and `metrics`; observed layers `[root, products] -> [metrics]`, the `metrics` dependency `products`, and downstream closure `[products, metrics]`.
- No browser check was required because Commit 3 adds no visible behavior.

Final Commit 4 validation on 2026-09-04:

- `npm test -- --run` passed 10 test files and 56 tests.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run build` passed.
- The offline production audit found 0 vulnerabilities.
- A browser-conditioned throwaway `tsx` smoke (`NODE_OPTIONS=--conditions=browser`) executed `input` → `derived` → Markdown `report`, published `# 42`, and reported executed IDs `input`, `derived`, and `report`.
- A larger browser-conditioned smoke executed `products`, `regions`, `pricedProducts`, `metrics`, and `report`; a changed-products transaction reran only the affected closure, changed the report from `12` to `24`, and retained the unchanged `regions` version.
- An initial smoke under default Node conditions emitted Solid's server-write warning. The browser-conditioned runs are the valid runtime proof because the application runtime uses Solid's browser condition.
- Module-only exports and `import.meta` receive stable preparation rejection before the unsandboxed `Function` boundary.
- No visible UI or browser surface changed, so no visual browser check was required.

Final Commit 5 validation on 2026-09-04:

- `npm test -- --run` passed 11 files and 62 tests.
- `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- The offline production audit found 0 vulnerabilities.
- An agent-browser Chromium dev-worker smoke observed `workerConstructed=false` and `workerConstructionCount=0` before the first request. Two concurrent exact `prepareFast` calls returned the same Promise; after completion the coordinator reported `workerConstructionCount=1` and `pendingCount=0`.
- The prepared revision exactly matched `JSON.stringify(document)`, and Vite served the real worker request at `/src/compiler/fast-worker.ts?worker_file&type=module`.
- The smoke executed an `input` → `answer` transaction and published `42`. There were no page errors; the console contained only Vite debug messages.
- Commit 5 changed no visible UI surface.

Final Commit 6 validation on 2026-09-04:

- `npm test -- --run` passed 13 files and 66 tests; `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- The offline production audit found 0 vulnerabilities.
- The production build emitted the fast worker at 3,469.12 kB uncompressed, main JavaScript at 68.68 kB (24.89 kB gzip), CSS at 8.96 kB (2.49 kB gzip), and `index.html` at 0.50 kB (0.31 kB gzip).
- A fresh agent-browser session made one worker request, reached `Notebook ready`, and showed all six executable cells succeeding. Products, regions, priced products, metrics, and the plain-text Markdown report published visible values.
- Collapse worked, zooming to `analysis` produced the derived breadcrumb path, and the root breadcrumb returned to the full tree.
- The reserved rename `value` remained in the editor with its inline alert. Renaming `metrics` to `metricsNew` reran the full notebook and surfaced the broken report path without rewriting report source; renaming back recovered success.
- SRC, OUT, and TYPE toggled independently. The report source still contained `root.analysis.metrics.value`, and Run all advanced runtime versions.
- At 1440 px wide, the tree and document scroll width were both 1440 px. An inactive node had transparent background, zero border, and no shadow; hidden actions had opacity 0 and `pointer-events: none`.
- At 390 × 844, the tree, body, and document widths were 390 px with no horizontal overflow. Actions had opacity 1 and `pointer-events: auto`, and the report reached ready state.
- Fresh-page errors were empty and the console contained only Vite connection debug messages.
- Review fixes made structural rename a full rerun, added idle output pending text, emitted Solid-compatible ARIA strings, pre-created runtimes outside `onSettled`, and removed `<Show>` function-child reads that were untracked under Solid 2.

## Performance measurements

Record measured values here with device, browser, build mode, fixture/revision, and date. Blank results mean no measurement has been taken.

| Scenario | Environment | Result | Date |
| --- | --- | --- | --- |
| Initial structure and prose visible |  |  |  |
| Uncached edit to first visible output |  |  |  |
| Uncached edit to semantic diagnostics |  |  |  |
| Exact-revision cached reopen to output |  |  |  |
| Exact-revision cached worker constructions |  |  |  |
| Fast preparation, uncached three-cell fixture | This workstation, agent-browser Chromium, Vite dev mode | 11.5 ms total; 2.5 ms analysis; 8.9 ms transpile; 2 cells transpiled; 0 reused. Small development fixture, not a cold production target. | 2026-09-04 |
| Large-notebook interaction |  |  |  |
