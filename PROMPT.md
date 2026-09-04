The product should combine:

Logseq/Roam-style hierarchical writing.
Marimo/Observable-style reactive computation.
CodeMirror-based prose and code editing.
TypeScript-powered notebook-aware autocomplete, diagnostics, hover information, and cross-cell type inference.
Templated, safely rendered Markdown.
Explicit and eventually transactional structural mutation.
A flat, minimal interface with no unnecessary card borders or padding.
Do not build a generic block editor with code snippets added afterward. The outline structure, reactive runtime, programmatic cell namespace, compiler coordinator, and editor tooling must be designed as one coherent system.

1. Working style and process
   Follow these project rules:

Before significant architectural or multi-file edits:

Present a concise implementation outline.
List the files and behaviors that will change.
Wait for approval unless explicitly told to implement everything.
Be conservative:

Prefer small, testable primitives.
Avoid large opaque rewrites.
Preserve stable IDs and serialized data.
Never silently rewrite user code.
Tests should precede or accompany substantial runtime, compiler, or structural work.

Keep durable project notes:

Maintain TODO.md.
Maintain CONTEXT.md.
Mark completed roadmap items.
Record performance measurements and architectural decisions.
Validate meaningful changes with:

npm test -- --run
npx tsc --noEmit
npm run lint
npm run build
npm audit --omit=dev
Browser-test visible and performance-sensitive behavior at desktop and mobile widths.

Do not report subjective performance improvements without measurements.

2. Product vision
   Build a full-page nested outliner inspired by:

Logseq
Roam Research
RemNote
Marimo
Observable notebooks
Every cell belongs to a normalized tree. A cell can be:

type CellKind = "text" | "javascript" | "markdown"
The three kinds are semantically distinct:

text: regular prose/note content.
javascript: executable typed JavaScript/TypeScript callback.
markdown: executable read-only template that returns Markdown.
The outline must support:

Arbitrary nesting.
Collapsing subtrees.
Zooming into any cell as the visible root.
Breadcrumb navigation.
Stable cell identity independent of location.
User-editable programmatic names.
Reactive references between cells.
Visible values, errors, run states, and inferred types.
Independent source, output, and type disclosures.
The interface should feel like a clean document, not a collection of raised dashboard cards.

3. Technology choices
   Use this stack unless there is a compelling, documented reason to change it:

Solid JS 2
TypeScript 5.9 or compatible current release
Vite
Vitest
CodeMirror 6
CSS Modules
Global CSS custom properties for themes
Oxc for move/refactor-oriented source analysis where appropriate
TypeScript compiler API for semantic type analysis
IndexedDB for bounded revision caches
marked for Markdown parsing
DOMPurify for sanitization
Do not use:

Tailwind
A heavy component framework
A styling runtime
A generic rich-text editor as a substitute for the outliner model
Use a conventional Vite SPA with:

index.html
src/main.tsx
Do not depend on experimental framework server modes unless their HTTP behavior has been explicitly verified.

4. Solid JS 2 considerations
   Account for these Solid 2 semantics:

classList is not treated as special in the same way as older Solid code may assume. Prefer a reactive class string.

Use the appropriate Solid 2 settled/mount lifecycle API. In the current design, imperative editors use onSettled for initialization and cleanup.

Solid effects use the Solid 2 API shape:

createEffect(compute, effect)
Writes inside owned scopes may be rejected by default. Avoid accidental reactive writes during tracked computations.

Never store a function directly as an unboxed signal value. Solid may interpret it as an updater or derived function.

Use:

createSignal({ current: initialValue })
Runtime transaction reads should use synchronous peek() values rather than forcing Solid flushes.

Serialized notebook data must stay separate from runtime signals and arbitrary JavaScript values.

5. Persisted notebook model
   Use a normalized, serializable tree:

type CellId = string

interface Cell {
id: CellId
kind: "text" | "javascript" | "markdown"
name?: string
source: string
classes: string[]
metadata: Record<string, unknown>
children: CellId[]
}

interface NotebookDocument {
rootId: CellId
cells: Record<CellId, Cell>
}
Important decisions:

Cell IDs are permanent and location-independent.
Tree structure is stored through children.
Parent relationships may initially be derived by searching children.
Do not store arbitrary live JavaScript values in the document.
Do not store reactive signals in the document.
Do not mix persisted source with derived runtime/compiler state.
The root cannot be deleted, moved, or given siblings.
Moving a cell moves its whole subtree.
A cell cannot move into itself or one of its descendants.
Commands must reject invalid operations atomically.
Cross-parent moves are allowed.
Relative named paths may change meaning after a cross-parent move.
Stable-ID references, once supported, remain stable.
Implement explicit commands such as:

appendChild(parentId, cell)
insertSibling(referenceId, position, cell)
update(cellId, patch)
move(cellId, target)
remove(cellId)
parentOf(cellId)
Keep structural changes centralized. Do not let arbitrary UI components mutate tree arrays directly.

6. Cell programmatic names
   Each cell must have a programmatic name separate from its display text or source.

Rules:

Names must be valid JavaScript identifiers.

Names must be unique only among siblings.

A descendant may reuse an ancestor’s name.

The same name may appear in unrelated branches.

Reject names that collide with built-in handle fields, including at least:

value
children
id
name
kind
text
update
append
remove
replaceChildren
Public create, rename, and cross-parent move commands must reject invalid names atomically.

Imported malformed snapshots should remain inspectable and diagnosable rather than crashing generated TypeScript.

Names omitted during creation should receive readable generated names, for example:

calmFern
amberCloud
quietRiver
Random/generated names must avoid sibling collisions.

Built-in demonstration data must use deterministic explicit names. Random names in hard-coded startup data break exact-revision caches across reloads.

The UI should support:

Inline renaming.
Enter or blur to save.
Escape to cancel.
Inline validation errors.
A small randomize action.
No silent source rewriting when names change.
A rename may temporarily break references and surface diagnostics. Automatic refactoring must be a separate, explicit, previewable operation.

7. Typed callback API
   Executable JavaScript cells use:

$(({ self, parent, root }) => {
return someValue
})
Templated Markdown cells use:

md(({ self, parent, root }) => {
return `# Markdown`
})
Support explicit output annotations:

$<ResultType>(({ root }) => {
return value
})
The callback context contains:

interface RuntimeContext {
self: CellHandle
parent: CellHandle | undefined
root: CellHandle
}
A read handle conceptually includes:

interface CellHandle<TValue, TChildren> {
readonly id: string
readonly name: string | undefined
readonly kind: CellKind
readonly text: string
readonly value: TValue
readonly children: TChildren
}
Each named child should also appear directly on its parent handle.

Both forms must work:

root.children.data.children.products.value
root.data.products.value
parent.pricedProducts.value
The direct path is the ergonomic default. The explicit .children path remains available as a structural form.

Markdown handles must be read-only. Do not expose structural mutation methods in generated Markdown context types.

JavaScript mutation methods may be added later, but they must be explicit and transactional.

8. Runtime registry
   Keep runtime state in an explicitly managed registry:

Map<CellId, CellRuntime>
A regular Map is intentional:

IDs are strings.
Runtime disposal must be deterministic.
Entries should not rely on garbage-collection semantics.
A runtime entry should expose:

type CellRunStatus =
| "idle"
| "pending"
| "success"
| "error"
| "cycle"

interface CellRuntime<T = unknown> {
value: Accessor<T>
peek(): T
status: Accessor<CellRunStatus>
error: Accessor<string | undefined>
version: Accessor<number>

publish(value: T): void
begin(): void
fail(error: unknown): void
markCycle(): void
dispose(): void
}
Requirements:

Box function values before storing them in signals.
peek() returns the synchronous current value.
Increment run version monotonically when a run resolves or fails.
Dispose removed cell entries explicitly.
Remove runtime entries for cells no longer present in the document.
Text cells publish their source string.
JavaScript cells may publish arbitrary synchronous values.
Markdown cells publish their returned Markdown string. 9. Execution semantics
The first execution engine may run synchronously in the browser page.

This is explicitly not a security sandbox.

Execution sequence:

Parse/analyze dependencies.
Prepare/transpile executable source.
Mark executable cells pending.
Execute cells in dependency order.
Publish results synchronously.
Allow downstream cells in the same transaction to read newly published upstream values through peek().
Isolate failures to the affected cell where possible.
Mark unresolved dependency loops as cycles.
Expected exact errors include:

Cell must call $() or md() with a callback
Async cell results are not supported yet
md() callback must return a string
Reactive dependency cycle
Cell has invalid TypeScript and was not executed
Additional runtime rules:

A cell may invoke $() or md() only once.
The API argument must be a callback.
Promises are rejected for now.
Imports and top-level await are not supported initially.
Cancellation and resource cleanup remain future work.
Do not imply the current Function-based execution model is safe for untrusted notebooks. 10. Dependency analysis
Track typed .value reads such as:

root.data.products.value
root.children.data.children.products.value
parent.pricedProducts.value
self.someChild.value
Resolve paths against notebook structure and programmatic names.

Dependencies drive:

Execution ordering.
Reactive reruns.
Cross-cell type inference.
Affected downstream closure calculations.
Move/refactor impact reporting.
Current acceptable limitations:

Computed property references may not be tracked:

root.data[key].value
Destructured or deeply aliased paths may not be tracked:

const { products } = root.data
products.value
Dynamic path analysis needs future hardening.

Use Oxc for move/refactor-oriented source analysis where its fast ranges and scope tracking are useful.

Use the TypeScript AST already present in compiler workers for semantic dependency analysis when that avoids shipping another parser into the same worker.

Do not silently rewrite source references after moves or renames.

Instead:

Detect impacted references.
Classify them as:
unchanged
changed meaning
missing
ambiguous
dynamic
invalid
Generate stable-ID or named-path rewrite suggestions.
Show a preview.
Apply only after explicit confirmation. 11. Cross-cell TypeScript inference
Text cells infer:

string
Explicit annotations are authoritative anchors:

$<MyType>(...)
For unannotated executable cells:

Analyze dependencies.
Process the graph topologically.
Generate typed context declarations from already known upstream value types.
Ask TypeScript for the callback’s published return type.
Feed that printed type into downstream declarations.
Normalize unusable results.
Mark invalid and cyclic cells as unknown.
Useful status values include:

"text"
"explicit"
"inferred"
"invalid"
"cycle"
Invalid and cyclic cells should not poison the whole notebook process.

Normalize {} to a more meaningful representation if appropriate, such as:

Record<string, never>
Explicit annotations may intentionally anchor cycles.

12. TypeScript virtual project
    Use one notebook-level compiler coordinator, not one whole-notebook compiler process per editor.

Generate deterministic virtual files using a structure like:

/notebook-schema.d.ts
/context-{encodedCellId}.d.ts
/cell-{encodedCellId}.ts
Important decisions:

One shared notebook schema declaration.

Tiny cell-specific context declarations.

One source file per executable cell.

Content-aware VFS writes.

Skip byte-identical updates.

Reuse unchanged transpiled JavaScript.

Cache completed notebook revisions.

Coalesce identical in-flight revision requests.

Source-only changes re-infer the edited/downstream closure.

Structural, kind, name, or location changes may safely invalidate the full type graph.

Use deterministic serialization as revision identity initially:

JSON.stringify(document)
A stronger hash can be introduced later if profiling justifies it.

Compiler APIs should support:

synchronize(document, cellId, source)
prepareFast(document)
prepareExecution(document)
completions(cellId, position)
diagnostics(cellId)
quickInfo(cellId, position)
Stale asynchronous responses must be revision-guarded. An old semantic result must never overwrite a newer runtime/document revision.

13. Fast execution and lazy semantic tooling
    Do not block initial execution on a full TypeScript language service.

Use two independently loaded workers.

Fast worker
Responsibilities:

Parse source.
Extract dependency paths.
Perform syntax-oriented validation.
Transpile TypeScript syntax to browser-compatible JavaScript.
Return provisional types.
Prepare execution.
It must not initialize:

TypeScript VFS.
Full standard-library declarations.
Semantic language service.
A fast prepared cell should contain:

interface PreparedCell {
code?: string
type: string
dependencies: string[]
status: "text" | "explicit" | "inferred" | "invalid" | "cycle"
}
Semantic worker
Responsibilities:

Full TypeScript virtual project.
Standard-library declarations.
Cross-cell return-type inference.
Diagnostics.
Autocomplete.
Hover and quick info.
Authoritative inferred types.
Scheduling
Use split scheduling:

Execution debounce: approximately 120 ms
Semantic diagnostics: approximately 350 ms after fast output
Completion/hover: immediate on explicit demand
Important behavior:

Plain editor focus should not automatically initialize semantic TypeScript.
A source change may mark diagnostics as needed.
Completion and hover can demand-start semantic tooling.
On an uncached revision, semantic work should begin after fast output renders, avoiding CPU contention before first visible results.
On an exact cached reopen, neither worker should start unless the user asks for tooling or changes source. 14. Lightweight semantic inference
Reduce repeated TypeScript program reconstruction.

Process topological layers rather than one cell at a time.

Instead of:

write A
build/check program
query A

write B
build/check program
query B
Use:

identify independent ready layer [A, B, C]
write A, B, C
build/check one program
query A, B, C
publish their inferred types
continue to next layer
Cells in the same topological layer cannot depend on each other, so this preserves dependency semantics.

Also:

Reuse previous inference results for unaffected cells.
Compute a downstream closure for source-only changes.
Reuse unchanged transpiled code.
Skip byte-identical VFS writes.
Preserve explicit and text-cell types without querying TypeScript. 15. Revision cache and immediate hydration
Use IndexedDB for a bounded, versioned cache.

Do not use localStorage for large compiler/runtime records.

A cache record should include:

interface NotebookCacheRecord {
version: number
compilerVersion: string
revision: string
savedAt: number
prepared: PreparedNotebook
values: Record<CellId, unknown>
}
The compiler compatibility version should encode changes to at least:

TypeScript version.
Generated schema format.
Runtime execution format.
Cache record format.
For example:

typescript-5.9|schema-1|runtime-1
Cache rules:

Key records by exact document revision.
Store compiled code.
Store inferred type/dependency metadata.
Store JSON-safe runtime outputs.
Omit non-serializable values.
Reject malformed or partial records atomically.
Reject incompatible cache/compiler/schema/runtime versions.
Bound storage, for example to the eight newest revisions.
Strip transient timing metadata before persistence.
Never treat a stale revision as current.
On an exact cached reopen:

Mount structure and prose immediately.
Load the IndexedDB record.
Publish cached values immediately.
Seed cached inferred metadata.
Render output before compiler startup.
Optionally re-execute cached compiled code after a frame.
Do not perform initial semantic inference.
Do not load either worker until source changes or tooling is requested.
Persisted hard-coded demonstration notebooks must use deterministic names and stable source ordering, or exact-revision cache reuse will fail.

Display cached output as cached/stale if the product needs to communicate that semantic distinction. Do not pretend cached values are newly executed values until execution confirms them.

16. CodeMirror integration
    Use CodeMirror 6 directly.

Avoid an unnecessary framework wrapper. Its imperative lifecycle maps cleanly to Solid cleanup.

Use CodeMirror for:

JavaScript/TypeScript source.
Markdown templates.
Regular prose editing.
Regular prose should not use a plain <textarea> because Markdown and outliner editing semantics should evolve consistently.

JavaScript editor features:

TypeScript-aware completion.
Diagnostics.
Hover information.
Syntax highlighting.
Notebook path completion.
Escape blurs the editor.
Source synchronization with notebook state.
Future Mod+Enter run support.
Templated Markdown uses JavaScript/TypeScript syntax because its source is an md(callback) program.

Plain note editing uses Markdown-oriented CodeMirror behavior.

17. Exact Markdown preview/edit height parity
    For ordinary prose notes:

Render sanitized Markdown by default.
Enter CodeMirror edit mode on click.
Return to preview on blur or Escape.
Exact static/editing height parity is non-negotiable.

Use a structural solution:

Keep preview and editor mounted simultaneously.

Place them in the same CSS grid area.

Hide the inactive layer with:

visibility: hidden;
pointer-events: none;
Do not use display: none for the inactive layer.

Let both layers contribute to shared intrinsic sizing.

Keep editing and preview typography compatible.

Do not add editing-only left padding, left accents, box shadows, or backgrounds that change geometry.

Browser-test with getBoundingClientRect() at desktop and mobile widths.

The values must be exactly equal for:

static
editing
post-edit
Do not accept “visually close.”

18. Markdown safety
    Use:

marked to parse Markdown.
DOMPurify to sanitize generated HTML.
Never render callback-produced HTML unsafely.

Markdown callback requirements:

md(({ root }) => `# Report`)
Callback must return a string.
The resulting string is the cell’s published value.
The output is rendered as sanitized Markdown.
Markdown gets read-only notebook handles.
Successful Markdown output should look like ordinary document content.
Do not permanently show a large MARKDOWN / run 1 output header.
Show error/pending UI only when it conveys useful state. 19. UI and visual direction
The interface should be:

Full-screen.
Full-width.
Flat.
Minimal.
Quiet.
Document-like.
Responsive on desktop and mobile.
Do not center the outline in a narrow fixed-width page. The user explicitly wants it full width.

Inactive cells
Inactive nodes must have:

background: transparent
border: 0
box-shadow: none
Avoid:

Permanent cards.
Raised surfaces.
Multiple nested borders.
Large padding.
Excessive visual containers.
Badge-heavy headers.
Large status chrome.
Active cells
Use subtle treatment only for the directly active or hovered cell.

Be careful with recursive CSS. Use direct-child selectors such as:

.card:hover > .main
.selected > .main
Do not use:

.card:hover .main
.selected .main
The latter activates every descendant when a parent is hovered or selected.

Actions
Hide inactive actions entirely.
Reveal actions only on direct hover or focus.
Use both opacity: 0 and pointer-events: none when hidden.
Keep controls available but visually secondary.
Metadata
Cell name, kind, status, and type affordances should be small and quiet.
Kinds may use the project color scheme but should not look like large badges.
Bullets and hierarchy lines should be subtle.
Source and output areas should use tonal separation rather than boxes.
Use borders only where they communicate state:
Focused source
Error
Open type panel
Dialog
Menu
Markdown templates
Default templated Markdown to rendered output with source collapsed.
Keep independent SRC and OUT controls.
Do not wrap successful rendered Markdown in conspicuous output chrome.
Full-width layout
The tree should use the available width:

.tree {
margin: 0;
max-width: none;
}
Do not introduce a centered 54rem or 56rem document column.

20. Theming
    Use CSS Modules for component-local classes and global CSS custom properties for composable themes.

Create semantic tokens such as:

--canvas
--canvas-raised
--code-canvas
--surface-subtle
--line
--selection
--accent
--accent-soft
--danger
--ink
--ink-strong
--ink-muted
--ink-faint
--syntax-keyword
--syntax-name
--syntax-string
--syntax-number
--syntax-comment
--syntax-type
--syntax-operator
--font-ui
--font-mono
--radius-sm
--radius-md
--shadow
Do not hardcode a separate color system inside every component.

The design can use its own color scheme, but the structural minimalism should remain independent of theme.

21. Output display
    JavaScript output should support structured JSON-like formatting.

Handle:

undefined
Strings
Functions
BigInts
Objects
Arrays
Circular/unserializable values
Do not crash output rendering when JSON.stringify fails.

Markdown output should render sanitized Markdown.

Error output must remain visible and clearly differentiated without turning every successful output into a bordered panel.

22. Outliner editing semantics roadmap
    The target is Logseq-like editing for regular prose.

Implement progressively:

Enter splits a note at the cursor and creates the next sibling.
Tab indents under the previous sibling.
Shift+Tab outdents one level.
Backspace in an empty note removes it and focuses the previous visible cell.
Arrow keys cross cells only at the first or last visual line.
CodeMirror code cells keep normal Enter and Tab behavior.
Arrow keys leave code cells only at document boundaries.
Mod+Enter runs.
Alt+Enter runs and creates a note sibling.
Focus behavior must work for keyboard and touch users.
Do not apply Logseq split/indent behavior blindly inside JavaScript code.

23. Structural mutation roadmap
    Eventually expose explicit typed operations such as:

append(...)
upsert(...)
update(...)
remove(...)
replaceChildren(...)
Requirements:

Mutations must be transactional.
Reads remain reactive.
Structural writes remain explicit.
Markdown receives no mutation methods.
Use stable keys for idempotent generated children.
Effectful cells should default to manual execution.
Detect write/read feedback loops.
Couple subtree deletion to runtime cleanup.
Add undo/redo for structural transactions.
Offer move-impact choices before rewriting references.
Do not expose a mutable tree object directly to callbacks.

24. Rename and move refactors
    Current policy:

Names can be edited.
References are not silently rewritten.
Broken paths surface as diagnostics.
Future refactor behavior:

Parse typed direct and explicit paths.
Find references to the renamed or moved cell.
Show exact source edits.
Show whether each edit preserves:
Relative structure
Original target
Stable ID
Let the user explicitly apply or reject the refactor.
Keep edits atomic.
Never silently modify source. 25. Performance expectations
Measure at least:

Main application download and parse.
Fast worker download.
Semantic worker download.
Standard-library/VFS initialization.
Dependency analysis.
Cross-cell inference.
Virtual-file synchronization.
Transpilation.
Execution.
Render completion.
Warm source edit.
Exact cached reopen.
Useful instrumentation fields:

interface CompilerTimings {
projectInitializationMs: number
inferenceMs: number
synchronizationMs: number
transpilationMs: number
workerRequestMs: number
affectedCells: number | "all"
virtualWrites: number
skippedVirtualWrites: number
}
Current reference measurements from the prototype:

Before pipeline split:
Cold output: ~1.98 s
TypeScript startup: ~967 ms
Notebook inference: ~329 ms
Worker download: ~83 ms
Old warm update: ~645 ms
Old debounce: 350 ms
After fast/semantic split and revision cache:

First uncached output: ~1.05 s
Exact cached reload: ~92 ms in one reload measurement
Fresh cached navigation: up to ~777 ms including navigation/app load
Workers on cached reopen: none
Execution debounce: 120 ms
Semantic delay after output: 350 ms
Current approximate worker sizes:

Fast worker uncompressed: ~3.46 MB
Semantic worker uncompressed: ~5.87 MB
The fast worker remains large because the TypeScript parser/transpiler itself is large. Further optimization may require:

A smaller transpiler.
Precompiled persisted code.
Lazy CodeMirror loading.
Server-side preparation.
An Oxc-based browser transpilation path if bundle/runtime tradeoffs are acceptable.
Compression and immutable caching.
Avoiding the fast worker entirely on exact cached revisions.
Do not reintroduce a runtime CDN waterfall for TypeScript standard libraries merely to reduce the emitted worker size. Local bundling was chosen because it improved actual startup reliability and speed.

26. Browser integration considerations
    If embedding in an iframe or host application:

App-owned Escape behavior takes precedence for editors, menus, dialogs, and games.
Only forward an unhandled Escape to the host.
Keep the app functional when loaded directly outside an iframe.
Do not depend on host-provided user context unless the feature actually needs it.
Support both mobile and desktop widths.
Verify no horizontal document overflow at approximately 390px. 27. Security and execution limitations
Be explicit:

User code currently runs via Function in the browser page.
This is not a sandbox.
Do not execute untrusted notebooks.
Async results are unsupported.
Cancellation is unsupported.
Imports are unsupported.
Top-level await is unsupported.
Timers, subscriptions, and resource cleanup are not yet modeled.
Arbitrary live values are not necessarily serializable.
Cache persistence omits values that cannot be represented safely as JSON.
Before accepting untrusted code, evaluate:

Dedicated execution Web Workers.
QuickJS/WASM isolation.
SES or hardened realms.
Capability-based host APIs.
Timeouts and worker termination.
Resource quotas.
CSP implications.
Do not conflate moving the compiler to a worker with sandboxing execution.

28. Example notebook
    Use a demonstration notebook with deterministic IDs and names.

Example data cell:

$(() => [
{ sku: "lamp", name: "Paper Lamp", price: 42, region: "eu" },
{ sku: "chair", name: "Low Chair", price: 125, region: "us" },
{ sku: "vase", name: "Stone Vase", price: 68, region: "eu" },
{ sku: "desk", name: "Oak Desk", price: 310, region: "us" },
])
Region configuration:

$(() => ({
eu: { tax: 0.2, discount: 0.08, currency: "EUR" },
us: { tax: 0.07, discount: 0.05, currency: "USD" },
}))
Dependent products:

$(({ root }) => {
const products = root.data.products.value
const regions = root.data.regions.value

return products.map(product => {
const region = regions[product.region as keyof typeof regions]
const discounted = product.price * (1 - region.discount)

    return {
      ...product,
      currency: region.currency,
      finalPrice: discounted * (1 + region.tax),
    }

})
})
Metrics:

$(({ parent }) => {
const products = parent.pricedProducts.value
const total = products.reduce(
(sum, product) => sum + product.finalPrice,
0,
)

return {
productCount: products.length,
total,
average: total / products.length,
mostExpensive: products.reduce((best, product) =>
product.finalPrice > best.finalPrice ? product : best
),
}
})
Reactive Markdown dashboard:

md(({ root }) => {
const products = root.data.products.value
const metrics = root.analysis.metrics.value
const priceBar = "▰".repeat(Math.round(metrics.average / 25))
const productParade = products
.map(product => `**${product.name}**`)
.join(" · ")

return `# 🛍️ Tiny Commerce Lab

We currently have **${metrics.productCount} products**:

${productParade}

**Average-price-o-meter:** ${priceBar}
**${metrics.average.toFixed(2)}**

The heavyweight champion is
**${metrics.mostExpensive.name.toUpperCase()}**
at **${metrics.mostExpensive.finalPrice.toFixed(2)}
${metrics.mostExpensive.currency}**.
`
})
Editing the products cell should rerun:

products
→ pricedProducts
→ metrics
→ Markdown dashboard
Unaffected branches should reuse previous inference and compiled code where possible.

29. Testing requirements
    At minimum, add tests for:

Notebook model
Creation.
Updates.
Moves.
Deletion.
Root protection.
Cycle prevention.
Cross-parent moves.
Atomic rejection.
Sibling-name uniqueness.
Valid descendant name reuse.
Runtime
Boxed function values.
Publish and peek().
Status transitions.
Version increments.
Error isolation.
Cycle reporting.
Disposal.
Dependency analysis
Direct named paths.
Explicit .children paths.
Root, parent, and self.
Invalid paths.
Explicit output annotations.
Cycles.
Shadowing where applicable.
Inference
Text cells infer string.
Explicit annotations anchor types.
Topological inference.
Same-layer batching.
Invalid cells become unknown.
Cycles become unknown.
Downstream inference receives upstream printed types.
Unaffected cells are reused.
Worker coordinator
Identical in-flight requests coalesce.
Completed exact revisions are reused.
Fast and semantic requests route to separate workers.
A seeded exact revision returns without constructing a worker.
Stale responses do not overwrite newer revisions.
Cache
Exact revision accepted.
Changed revision rejected.
Compiler-version mismatch rejected.
Malformed records rejected.
Missing executable preparation rejected appropriately.
Timing metadata stripped.
Non-serializable values omitted.
Old revisions pruned.
Execution
Dependency order.
Immediate upstream publication visible downstream.
Markdown string validation.
Missing callback errors.
Async rejection.
Invalid source isolation.
Cycle handling.
UI/browser
Markdown preview/edit height is exactly equal.
Inactive cells have no border, background, or shadow.
Descendant cards do not inherit parent hover treatment.
Hidden actions have no pointer interaction.
Full-width layout.
No horizontal overflow at mobile width.
Cached reopen loads no workers.
First output occurs before semantic worker initialization.
Browser console contains no errors or warnings. 30. Known remaining roadmap
After the core system is stable, prioritize:

Rename-refactor previews.
Explicit typed transactional mutations.
Runtime cleanup and cancellation.
Async execution and resource ownership.
Logseq-like prose splitting and indentation.
Better alias/computed dependency tracking.
Lazy CodeMirror loading.
Persistence and migration of notebook documents themselves.
Import/export.
Undo/redo.
Large-notebook fixtures.
Theme switching.
Secure execution isolation.
Compression and cache tuning for workers.
Potential smaller fast transpiler. 31. Non-negotiable acceptance criteria
The implementation is not complete unless all of these hold:

The notebook is a normalized nested tree.
Cells have stable IDs.
Programmatic names are valid and sibling-scoped.
Direct paths such as root.data.products.value work.
Explicit .children paths also work.
JavaScript cells publish visible values.
Markdown templates rerun reactively.
Errors and cycles are visible.
Cross-cell return types feed downstream TypeScript.
Autocomplete and hover understand notebook structure.
Source, output, and type displays collapse independently.
Inactive cells are transparent, borderless, and shadowless.
The layout is full-width, not centered.
Parent hover does not style all descendants.
Prose preview and editing have exactly identical heights.
Markdown HTML is sanitized.
Exact cached revisions render outputs without loading either compiler worker.
Uncached execution does not wait for the semantic TypeScript project.
Execution and semantic diagnostics use separate schedules.
Stale compiler results cannot overwrite newer revisions.
Structural operations remain explicit.
Renames and moves never silently rewrite source.
Runtime execution is clearly documented as unsandboxed.
Tests, TypeScript, lint, build, and browser verification pass.
