# HiBook roadmap

Status: commits 1–3 are completed; commit 4 is pending.

1. **Completed — `chore: establish application and quality baseline`**  
   Vite, Solid, tooling, durable notes, semantic theme tokens, and the honest full-page shell.
2. **Completed — `model: add normalized notebook commands`**  
   Serializable types, whole-document diagnostics, pure structural commands, sibling-scoped naming, and focused tests.
3. **Completed — `runtime: resolve notebook paths and dependencies`**  
   Structural `root`/`parent`/`self` resolution, direct and `.children` paths, TypeScript AST extraction, deterministic graph layers, cycle groups, and downstream closure.
4. **Pending — `runtime: execute reactive notebook transactions`**  
   Registry, handles, synchronous execution, status, errors, and disposal.
5. **Pending — `compiler: add fast preparation worker`**  
   Parsing, dependencies, syntax validation, transpilation, revision guards, coalescing, and reuse.
6. **Pending — `ui: add deterministic reactive outliner`**  
   Tiny Commerce data, nested tree, collapse, zoom, breadcrumbs, disclosures, and rename.
7. **Pending — `editor: integrate CodeMirror and safe Markdown`**  
   Direct CodeMirror integration, prose height parity, Mod+Enter, marked plus DOMPurify, and output formatting.
8. **Pending — `compiler: add semantic inference and editor tooling`**  
   Virtual project, layered inference, completion, diagnostics, hover, and lazy semantic startup.
9. **Pending — `cache: hydrate exact notebook revisions`**  
   Versioned bounded IndexedDB records, JSON-safe values, and hydration before worker startup.
10. **Pending — `ui: complete responsive and accessible demo polish`**  
    Desktop and mobile browser checks, geometry, overflow, hover isolation, accessibility, and measurements.

## Demo boundary

The planned demo is a deterministic Tiny Commerce notebook that demonstrates the normalized outline, reactive synchronous execution, safe Markdown, notebook-aware TypeScript tooling, and exact-revision hydration. The current work adds static path and dependency analysis only; it does not execute cells or connect notebook behavior to the application.

## Deferred beyond the demo

- Callback structural mutation and typed transactions
- Undo and redo
- Rename/refactor previews and Oxc-assisted refactors
- Notebook document persistence, migrations, import, and export
- Async execution, cancellation, and resource ownership
- Secure execution isolation
- Dynamic and aliased dependency-path analysis
- Drag and drop, virtualization, and theme switching
