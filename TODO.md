# HiBook roadmap

Status: commits 1–10 and the follow-up local-first document milestone are complete.

1. **Completed — `chore: establish application and quality baseline`**  
   Vite, Solid, tooling, durable notes, semantic theme tokens, and the honest full-page shell.
2. **Completed — `model: add normalized notebook commands`**  
   Serializable types, whole-document diagnostics, pure structural commands, sibling-scoped naming, and focused tests.
3. **Completed — `runtime: resolve notebook paths and dependencies`**  
   Structural `root`/`parent`/`self` resolution, direct and `.children` paths, TypeScript AST extraction, deterministic graph layers, cycle groups, and downstream closure.
4. **Completed — `runtime: execute reactive notebook transactions`**  
   Registry, readonly handles, synchronous preparation and execution, status, errors, and deterministic disposal.
5. **Completed — `compiler: add fast preparation worker`**  
   Parsing, dependencies, syntax validation, transpilation, revision guards, coalescing, and reuse.
6. **Completed — `ui: add deterministic reactive outliner`**  
   Deterministic Tiny Commerce data, recursive tree, worker-backed execution, collapse, zoom, breadcrumbs, disclosures, and atomic inline rename.
7. **Completed — `editor: integrate CodeMirror and safe Markdown`**  
   Direct CodeMirror integration, prose height parity, Mod+Enter, marked plus DOMPurify, and output formatting.
8. **Completed — `compiler: add semantic inference and editor tooling`**  
   Virtual project, layered inference, completion, diagnostics, hover, and lazy semantic startup.
9. **Completed — `cache: hydrate exact notebook revisions`**
   Versioned bounded IndexedDB records, JSON-safe values, and hydration before worker startup.
10. **Completed — `ui: complete responsive and accessible demo polish`**
    Desktop and mobile browser checks, geometry, overflow, hover isolation, accessibility, and measurements.

## Demo boundary

The Tiny Commerce fixture remains available in source and tests, but new users now start with an unsaved blank writing surface. The local-first milestone adds document autosave/reopen, JSON export/import, document undo/redo, and a note-first chooser for adding calculations and live Markdown. Imported code stays paused until Run all is selected.

## Personal-document experiment

Observed on 2026-09-23 in the browser, starting from a blank local notebook and writing a Kyoto trip.

Before this slice, Enter only inserted a newline, Tab left the editor, and every guessed indent shortcut did nothing. Shift+Enter added an empty note named `warmHarbor` beneath the whole notebook. The kind chooser then added `$(() => 0)` as another child of that notebook, so the budget paragraph never became the calculation. The live-Markdown starter was `md(() => "# Live view")` and had no path to the budget until the writer typed `parent.steadyHarbor.value` by hand. Arrow keys never crossed cells, Backspace at the start of a note did not join it, and F2 did not start a rename. Once written, the budget did compute 138,600 yen and survived reload from the local cache.

This slice makes Enter split a note at the cursor, Tab/Shift+Tab indent and outdent, and a visible kind control turn a short note into a quoted calculation or live view. A second pass of the same trip confirmed the split, the nest, the conversion, the computed live view, and a cached reload. A later pass adds deletion of a note and its nested children, with undo.

## Deferred beyond the demo

- Callback structural mutation and typed transactions
- Coalesced editing history, richer rename/move refactor previews and Oxc-assisted refactors
- Multi-notebook management, cross-tab coordination, and future format migrations (v1 is validated; unknown versions are rejected)
- Richer reference insertion: a calculation still cannot see the note it came from unless the writer names a sibling, and converting a note quotes the prose rather than extracting numbers from it
- Async execution, cancellation, and resource ownership
- Secure execution isolation
- Dynamic and aliased dependency-path analysis
- Drag and drop, virtualization, and theme switching
