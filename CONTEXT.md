# HiBook context

## Current state

Commits 1–9 are complete. The app uses a deterministic Tiny Commerce notebook as a full-width recursive outliner, with one lazy fast worker for preparation, normalized model commands for document and source changes, direct CodeMirror editing, sanitized rendered Markdown, and bounded exact-revision compiler/output hydration. A separate lazy semantic worker owns the notebook-wide TypeScript project and editor tooling. Notebook documents remain intentionally unpersisted.

## Architecture decisions

- Keep `index.html` and `src/main.tsx` as the conventional Vite SPA entry points. Framework server modes are out of scope.
- Use Solid 2 APIs and semantics. Future reactive code must use the Solid 2 effect shape, settled lifecycle, boxed function signal values, and synchronous `peek()` reads described in `PROMPT.md`.
- Keep serialized notebook documents separate from runtime signals, compiler state, and arbitrary JavaScript values.
- Use CSS Modules for component-local structure and global custom properties for theme semantics. The layout remains flat and full-width independently of color choices.
- Add dependencies only in the commit that uses them. Commit 7 directly owns the core CodeMirror editor, marked, DOMPurify, and its DOM-backed sanitizer test environment; Commit 8 adds CodeMirror autocomplete and lint primitives directly; Commit 9 adds fake-indexeddb only as a development dependency for IndexedDB behavior tests.
- Future notebook execution is an explicitly unsandboxed boundary: page-context execution must be treated as suitable only for trusted notebook code and must never be presented as safe isolation.

## Notebook model decisions

- Persisted state is `NotebookDocument { rootId, cells }`, where each `Cell` owns serializable data and an ordered `children` ID array. IDs are permanent and location-independent; parent relationships are derived rather than stored.
- The public model API is `createNotebook`, `appendChild`, `insertSibling`, `update`, `move`, `remove`, and `parentOf` in `src/model/commands.ts`, plus `validateNotebook` in `src/model/validate.ts`. Mutations return a typed `CommandResult`; lookup returns `ParentLookupResult`; malformed imports return typed validation diagnostics rather than throwing.
- New cells use `CellInput`, which excludes structural children. Commands create leaves, own all newly accepted arrays and deeply clone metadata, preserve source verbatim, and copy only cells and child arrays changed by the operation.
- The root cannot be removed, moved, or used as a sibling reference. Removal deletes the complete selected subtree. A move preserves subtree IDs and data, rejects self/descendant targets, and accepts either `{ type: \"child\", parentId, index? }` or `{ type: \"sibling\", referenceId, position }`. A same-parent child index addresses the destination child list after removing the moving cell.
- Cell names use Unicode ECMAScript identifier syntax, with `$`, `_`, join controls, and Unicode identifier characters supported. Handle fields `value`, `peek`, `children`, `id`, `name`, `kind`, `text`, `update`, `append`, `remove`, and `replaceChildren` are reserved. Uniqueness is sibling-scoped; ancestor, descendant, and unrelated branches may reuse a name.
- Omitted create names come from readable adjective/noun pairs, probe deterministically from an injectable random source, avoid sibling collisions, and use numeric suffixes only after exhausting the base pairs. Hard-coded notebook data must still supply explicit deterministic names.
- Whole-document validation checks root/key/identity consistency, cell data shapes and serializable metadata, child references, duplicate children and declared IDs, parent cardinality, reachability, cycles, name validity/reservations, and sibling collisions. Command errors and validation diagnostics use stable string codes.

## Static runtime analysis decisions

- `src/runtime/resolve-path.ts` is the single structural definition of notebook path meaning. Origins are resolved relative to the analyzed cell (`root`, `parent`, or `self`); direct named hops and explicit `.children` hops traverse the same ordered child IDs; only a terminal `.value` is an executable dependency read.
- Path outcomes are stable typed results: resolved targets carry permanent `CellId`s, while missing, ambiguous, dynamic, and invalid outcomes carry source spans and never add guessed edges. Repeated references to the same child ID remain resolvable, but distinct same-name children or multiple parents in malformed snapshots are ambiguous.
- `src/runtime/analyze-dependencies.ts` owns the TypeScript compiler API import. It analyzes `$` and `md` callbacks without executing code, preserves half-open source offsets and explicit `$<Type>` text, respects callback lexical shadowing including switch `CaseBlock` scope, reports computed or aliased handles, de-duplicates resolved target IDs, and leaves source unchanged. Scalar handle metadata and chains beyond runtime `.value` data are not misclassified as handle aliases or dependency paths; nested `.value` reads stop at the first runtime-value boundary. Text cells have no executable dependencies, and syntax/path failures remain per-cell issues.
- Graph order is root-first document traversal followed by any remaining cell keys. Dependency and dependent maps preserve that order; topological layers batch ready acyclic cells; strongly connected groups include self-cycles; cells downstream of cycles are reported separately without blocking unrelated branches. Downstream closure includes known changed IDs and every transitive dependent in document order.

## Headless execution decisions

- `src/runtime/registry.ts` owns live per-cell state in a regular `Map<CellId, CellRuntime>`. Each entry owns boxed Solid signal values plus synchronous imperative peek state; successful, failed, and cycle resolutions advance a monotonic version. Exact cached hydration publishes a defensive copy under an honest `cached` status without advancing that fresh-run version. Registry synchronization publishes text source separately and explicitly disposes entries removed from the serialized document.
- `src/runtime/read-handles.ts` derives frozen readonly handles from normalized structure. Direct named children and the explicit `children` form share handle identities, while `value` and `peek()` read the current registry value. Runtime handles expose no structural mutation API and are never stored in `NotebookDocument`.
- `src/compiler/fast-prepare.ts` owns syntax validation and transpilation for execution. Its worker-local cache reuses output only for byte-identical cell ID, kind, and source while every document revision rebuilds dependency/path meaning. Fast output carries provisional `string`, explicit annotation, `unknown`, invalid, and cycle type/status data plus serialized graph data and measured preparation counters.
- `src/compiler/fast-worker.ts` is the dedicated execution-preparation worker boundary. `src/compiler/coordinator.ts` constructs it only on the first uncached request, coalesces exact in-flight revisions, retains at most eight completed exact revisions in memory, rejects mismatched responses, prevents stale responses from becoming current, and provides the 120 ms replaceable/cancellable execution scheduler. A validated exact seed can populate the coordinator without constructing the worker. It does not import or initialize the semantic project, standard-library declarations, or Language Service.
- `src/compiler/semantic-core.ts` owns one content-aware virtual filesystem and one TypeScript Language Service for the complete notebook. Locally bundled TypeScript declaration files provide the standard library. Deterministic schema, per-cell context, and source files model readonly `root`, `parent`, `self`, direct named children, `.children`, `.value`, and `.peek()` handles; wrapper offsets are retained for source-relative tooling ranges.
- Semantic inference consumes the prepared graph's topological layers. Text and explicit annotations are authoritative anchors, a ready layer is synchronized before one shared Program query, cycle/invalid cells resolve to `unknown`, and a source-only changed/downstream closure reuses prior results outside that closure. The protocol is JSON-safe and carries exact request IDs and revisions with diagnostics, completions, quick info, timings, and VFS/inference counters.
- `src/compiler/semantic-worker.ts` is independent from the fast worker. `src/compiler/semantic-coordinator.ts` constructs it only for inference or tooling demand, coalesces exact-revision inference, rejects stale/mismatched work, disposes pending requests, and provides the replaceable 350 ms semantic scheduler. Completion, diagnostics, and quick-info requests synchronize and infer their exact project revision before querying.
- `src/runtime/execute.ts` consumes an exact `PreparedNotebook` or an explicitly injected notebook preparer. It has no synchronous TypeScript preparation fallback and no static dependency on TypeScript or the dependency analyzer; worker preparation does not alter transaction ordering, errors, or the intentionally unsandboxed `Function` execution boundary.
- Notebook programs currently execute with `Function` in the page realm. This is intentionally unsandboxed and suitable only for trusted notebook code; preparation in a worker will not make execution a security boundary. Cached compiled code is trusted same-origin data flowing into that same unsandboxed boundary. Compatibility and structural validation detect stale or corrupt records, but are not a security signature.
- `src/cache/record.ts` defines the versioned compatibility boundary for TypeScript 5.9.3 and the current notebook schema, runtime, and cache formats. A record is accepted only as one exact unit: document and prepared revisions, complete per-cell prepared output, dependency references and graph structure, finite counters, zero transient timing fields, and JSON-safe cached values must all validate. Runtime values are copied without invoking accessors; one unsafe cell value is omitted rather than partially serialized.
- `src/cache/indexeddb.ts` owns the single revision-keyed IndexedDB store. It handles creation, blocked/error/version-change lifecycle, transactional writes, malformed exact-hit cleanup, and deterministic pruning to the eight newest saved revisions. Cache failure is non-authoritative and falls back to ordinary preparation and execution.

## Reactive outliner decisions

- `src/demo/notebook.ts` is the deterministic Tiny Commerce fixture. Every cell has an explicit stable ID and programmatic name; its sources exercise direct, explicit `.children`, and expected-parent paths, while a separate executable branch remains available for later compiler-reuse demonstrations.
- The App-owned notebook controller keeps serialized document, fast prepared output, semantic output, cache hydration state, and application errors in separate boxed signals. It owns independent lazy fast and semantic coordinators, the 120 ms execution-preparation scheduler, the post-fast semantic scheduler, one runtime registry, and the exact-revision IndexedDB cache. Initial cell runtimes and text structure exist before an asynchronous guarded cache lookup. An exact hit hydrates copied values and cached type metadata and seeds fast preparation without execution or semantic inference; a miss follows the ordinary fast → execute → semantic path. Revision/disposal guards prevent stale async publication, cache failures do not become execution failures, and cleanup disposes storage, workers, schedules, and runtime state.
- Rename remains a model `update` command and changes only the programmatic name. Successful structural name changes prepare the new exact revision and rerun the whole document so newly resolving or missing paths cannot be skipped; invalid changes stay atomic and expose the typed command message inline.
- Source edits also use the model `update` command. Ordinary edits replace the pending 120 ms preparation and execute only the edited cell plus the prepared graph's downstream closure. Successful fast output then replaces the pending semantic delay with the edited-cell closure, allowing unaffected semantic results to be reused. Mod/Ctrl+Enter cancels a pending fast delay and runs the same changed-cell path immediately.
- Collapse, selection, zoom, disclosures, prose edit mode, and rename draft/error state are transient, ID-keyed UI state. Breadcrumbs are derived from normalized structure rather than persisted metadata.
- `CodeEditor` owns direct CodeMirror `EditorView` construction and destruction in `onSettled`; reactive source synchronization dispatches only when editor and model text differ, so model updates do not reset the cursor in an echo loop. Executable cells add an explicit-only asynchronous completion source, source-relative diagnostics through CodeMirror lint state, and demand-started hover quick info. Focusing an editor does not request semantic tooling, and text cells remain Markdown-only editors.
- Prose preview and editor layers remain mounted in the same CSS grid area. The inactive layer uses only `visibility` and `pointer-events`, so both layers continue contributing to one stable host height while preview/edit state changes.
- `renderMarkdown` is the sole HTML-producing Markdown path: marked parses source and DOMPurify sanitizes the result before either prose preview or executable Markdown output assigns `innerHTML`. JavaScript values continue through the structured defensive formatter, and runtime errors remain text.

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
| `@codemirror/state` / `view` / `commands` / `language` / `autocomplete` / `lint` | `6.7.3` / `6.43.11` / `6.11.0` / `6.12.4` / `6.20.3` / `6.9.7` | Direct editor state, view, command, language, completion, and diagnostic primitives without a framework wrapper. |
| `@codemirror/lang-javascript` / `lang-markdown` | `6.2.5` / `6.5.2` | JavaScript/TypeScript executable-cell syntax and prose Markdown syntax. |
| `marked` / `dompurify` | `18.0.11` / `3.4.14` | Markdown parsing followed by DOM-based sanitization at the only HTML rendering boundary. |
| `jsdom` | `29.0.0` | Development-only DOM environment for observable sanitizer behavior tests; its engine range matches the project Node baseline. |
| `fake-indexeddb` | `6.2.5` | Development-only IndexedDB implementation for upgrade, transaction, pruning, corruption, and version-change behavior tests. |

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

Final Commit 7 validation on 2026-09-04:

- `npm test -- --run` passed 14 files and 67 tests; `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- The offline production audit found 0 vulnerabilities.
- The production build emitted the fast worker at 3,469.12 kB uncompressed, main JavaScript at 661.41 kB (229.59 kB gzip), CSS at 9.75 kB (2.65 kB gzip), and `index.html` at 0.50 kB (0.31 kB gzip).
- A fresh desktop browser session reached `Notebook ready`, showed every executable cell succeeding, and rendered direct CodeMirror editors.
- The desktop prose host, preview, and editor measured exactly 36.09375 px high before editing, during editing, and after returning to preview. Visibility switched between layers and focus moved to the labeled CodeMirror content.
- At 390 × 844, the body and document widths were exactly 390 px and actions remained visible. After a multiline prose edit, the prose host, preview, and editor measured exactly 152.65625 px high in preview, edit, and post-edit preview states.
- Editing the products source reran products, priced products, metrics, and report; regions and the unrelated branch remained at run 1. The edited notebook produced a 55.20 final price and average plus a one-product report. Mod+Enter advanced the current changed-cell path.
- Prose and executable Markdown payloads containing scripts, event handlers, and `javascript:` URLs left the global XSS sentinel at 0, produced no script nodes, event-handler attributes, or dangerous link nodes, and preserved safe headings.
- Browser page errors were empty; the console contained only Vite connection debug messages.
- A fresh axe scan reported one serious color-contrast violation across 10 faint kind labels and one incomplete result. Contrast polish remains assigned to Commit 10; Commit 7 does not claim zero accessibility issues.
- The sanitizer test was corrected during review to assert DOM security behavior rather than incidental marked output such as anchor counts or raw serialized text.


Final Commit 8 validation on 2026-09-04:

- `npm test -- --run` passed 16 files and 83 tests; `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- The offline production audit found 0 vulnerabilities.
- The production build emitted the fast worker at 3,469.12 kB, the semantic worker at 6,625.81 kB, main JavaScript at 720.17 kB (248.01 kB gzip), CSS at 10.15 kB (2.72 kB gzip), and `index.html` at 0.50 kB (0.31 kB gzip).
- An immediate startup trace at `Preparing` showed only the fast worker. Its response preceded the semantic worker request scheduled about 350 ms later. At ready state, products, regions, priced products, and metrics had inferred types, the report had type `string`, and the metrics TYPE panel reported `data-semantic-status="authoritative"`.
- Explicit Ctrl+Space at `parent.` offered notebook-aware children, `id`, `kind`, `metrics`, `pricedProducts`, `value`, and `peek`; an invalid partial source reported `Identifier expected`.
- Hovering `pricedProducts` after the publication fix sent exactly one quick-info request and rendered its complete readonly typed-handle tooltip. A fresh focus before the semantic delay kept the source editor active while the trace still contained only the fast preparation message, proving focus alone did not demand semantic work.
- A browser-global edit using `document` and `window` executed successfully and inferred `boolean` without an error. Browser page errors were empty, and the console contained only Vite debug and hot-module-reload messages.
- Review and validation corrections selected the full local DOM library, bounded completed semantic revisions to eight, made completion type mapping exact-optional-safe, corrected the no-unchecked-indexed-access fixture, and made same-revision tooling publication idempotent to eliminate the observed 42-request hover loop.

Final Commit 9 validation on 2026-09-04:

- `npm test -- --run` passed 18 files and 92 tests; `npm run typecheck`, `npm run lint`, and `npm run build` passed.
- The offline production audit found 0 vulnerabilities.
- The production build emitted the fast worker at 3,469.12 kB, the semantic worker at 6,625.81 kB, main JavaScript at 733.63 kB (252.30 kB gzip), CSS at 10.46 kB (2.78 kB gzip), and `index.html` at 0.50 kB (0.31 kB gzip).
- A first uncached load constructed both workers and wrote one IndexedDB record. It had record version 1, the exact compatibility string, matching record/prepared revisions, 11 complete prepared cells, 11 safe runtime values, inferred types, and zero persisted `totalMs`, `analysisMs`, and `transpileMs` durations.
- An exact reload showed `Cached results · run to refresh`, six executable `cached` statuses, stale notices, the full report, and cached metrics TYPE output with zero worker resources or messages. Focusing during cached reopen still constructed no worker; explicit Ctrl+Space constructed only the semantic worker and returned notebook completions. A subsequent reload retained all cached outputs.
- Editing products constructed the fast and semantic workers and refreshed products, priced products, metrics, and report to fresh `success · run 1` output with the one-product 55.20 result. Regions and the unrelated branch version remained cached and visible.
- Browser errors were empty, the console contained only Vite debug messages, and the visual screenshot confirmed clear cached/stale labels.
- Review corrections preserved cached values during semantic-only refreshes, accepted complete rejected prepared cells, retained unaffected cached branches during targeted runs, and fixed strict local narrowing and hydration cleanup control flow.

## Performance measurements

Record measured values here with device, browser, build mode, fixture/revision, and date. Blank results mean no measurement has been taken.

| Scenario | Environment | Result | Date |
| --- | --- | --- | --- |
| Initial structure and prose visible |  |  |  |
| Uncached edit to first visible output |  |  |  |
| Uncached edit to semantic diagnostics |  |  |  |
| Exact-revision cached reopen to output | This workstation, agent-browser Chromium, Vite dev mode | Cached status and visible output at 50.4 ms. | 2026-09-04 |
| Exact-revision cached worker constructions | This workstation, agent-browser Chromium, Vite dev mode | Zero worker resources and zero worker messages before tooling or execution demand. | 2026-09-04 |
| Fast preparation, uncached three-cell fixture | This workstation, agent-browser Chromium, Vite dev mode | 11.5 ms total; 2.5 ms analysis; 8.9 ms transpile; 2 cells transpiled; 0 reused. Small development fixture, not a cold production target. | 2026-09-04 |
| Tiny Commerce initial compiler trace | This workstation, agent-browser Chromium, Vite dev mode | Fast request at 48.0 ms and response at 206.8 ms; fast core 18.7 ms total (4.8 ms analysis, 13.8 ms transpile, 11 cells, 6 transpiled). Semantic request at 559.2 ms and response at 830.6 ms; semantic core 111.1 ms total (0.2 ms sync, 110.9 ms inference, 17 writes, 1 skip, 4 layers, 4 builds). Development timing, not a production target. | 2026-09-04 |
| Warm Tiny Commerce products edit | This workstation, agent-browser Chromium, Vite dev mode | Fast core 2.6 ms total (1.3 ms analysis, 1.3 ms transpile, 5 reused, 1 transpiled). Semantic core 13.4 ms total (0.6 ms sync, 12.8 ms inference, 6 writes, 12 skips, 4 layers, 4 builds, 7 reused); the one-product report showed 55.20. Development timing, not a production target. | 2026-09-04 |
| Large-notebook interaction |  |  |  |
