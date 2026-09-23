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

## Deferred beyond the demo

- Callback structural mutation and typed transactions
- Coalesced editing history, richer rename/move refactor previews and Oxc-assisted refactors
- Multi-notebook management, cross-tab coordination, and future format migrations (v1 is validated; unknown versions are rejected)
- A user-observed personal-document experiment to guide progressive enrichment and reference insertion
- Async execution, cancellation, and resource ownership
- Secure execution isolation
- Dynamic and aliased dependency-path analysis
- Drag and drop, virtualization, and theme switching
