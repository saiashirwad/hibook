import { EditorView } from "@codemirror/view";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { Cell, CellId, CellKind } from "../model/types";
import type { CellRunStatus } from "../runtime/registry";
import CodeEditor from "./CodeEditor";
import { formatValue } from "./format-value";
import type { NotebookController } from "./notebook-controller";
import { renderMarkdown } from "./render-markdown";
import { breadcrumbsFor } from "./tree-helpers";
import type { NotebookViewState } from "./view-state";
import styles from "./NotebookTree.module.css";

interface NotebookTreeProps {
  readonly controller: NotebookController;
  readonly view: NotebookViewState;
}

interface CellNodeProps extends NotebookTreeProps {
  readonly cellId: CellId;
  readonly depth: number;
}

interface RenameInputProps {
  readonly cellId: CellId;
  readonly value: string;
  readonly error: string | undefined;
  readonly onInput: (value: string) => void;
  readonly onSave: (input: HTMLInputElement) => void;
  readonly onCancel: (input: HTMLInputElement) => void;
}

interface RuntimeOutputProps {
  readonly kind: CellKind;
  readonly status: CellRunStatus;
  readonly value: unknown;
}

interface SourceEditorProps {
  readonly cell: Cell;
  readonly controller: NotebookController;
  readonly onCreateAfter: () => void;
}

const KIND_LABEL: Record<CellKind, string> = {
  text: "prose",
  javascript: "js",
  markdown: "md",
};

const CELL_KINDS: readonly CellKind[] = ["text", "javascript", "markdown"];

function RenameInput(props: RenameInputProps) {
  let cancelled = false;

  return (
    <input
      ref={(input) => {
        onSettled(() => {
          input.focus();
          input.select();
        });
      }}
      class={styles.renameInput}
      value={props.value}
      aria-label={`Programmatic name for ${props.cellId}`}
      aria-invalid={props.error === undefined ? "false" : "true"}
      aria-describedby={
        props.error === undefined ? undefined : `rename-error-${props.cellId}`
      }
      onInput={(event) => props.onInput(event.currentTarget.value)}
      onBlur={(event) => {
        if (!cancelled) props.onSave(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelled = true;
          props.onCancel(event.currentTarget);
        }
      }}
    />
  );
}

function RuntimeOutput(props: RuntimeOutputProps) {
  const settled = () => props.status === "success" || props.status === "cached";
  const showValue = () =>
    settled() || (props.status === "pending" && props.value !== undefined);
  const markdownHtml = createMemo(() =>
    props.kind === "markdown" && typeof props.value === "string"
      ? renderMarkdown(props.value)
      : undefined,
  );
  const formattedValue = createMemo(() => formatValue(props.value));

  return (
    <Show
      when={showValue()}
      fallback={
        <Show when={props.status === "idle" || props.status === "pending"}>
          <p class={styles.pendingOutput}>Waiting for execution…</p>
        </Show>
      }
    >
      <Show
        when={markdownHtml() !== undefined}
        fallback={
          <pre class={styles.valueOutput} data-status={props.status}>
            {formattedValue()}
          </pre>
        }
      >
        <div
          class={styles.markdownOutput}
          data-status={props.status}
          data-markdown-output=""
          innerHTML={markdownHtml() ?? ""}
        />
      </Show>
    </Show>
  );
}

function ProseSource(props: SourceEditorProps) {
  return (
    <div class={styles.prose} data-prose-editor={props.cell.id}>
      <CodeEditor
        source={props.cell.source}
        kind="text"
        ariaLabel={`Prose for ${props.cell.id}`}
        onChange={(source) =>
          props.controller.updateCellSource(props.cell.id, source)
        }
        onRun={() => props.controller.runCell(props.cell.id)}
        onCreateAfter={props.onCreateAfter}
      />
    </div>
  );
}

function ExecutableSource(props: SourceEditorProps) {
  const diagnostics = createMemo(
    () => props.controller.semanticFor(props.cell.id).result?.diagnostics,
  );

  return (
    <div class={styles.codeSource} data-source-editor={props.cell.id}>
      <CodeEditor
        source={props.cell.source}
        kind={props.cell.kind}
        ariaLabel={`Source for ${props.cell.id}`}
        onChange={(source) =>
          props.controller.updateCellSource(props.cell.id, source)
        }
        onRun={() => props.controller.runCell(props.cell.id)}
        onCreateAfter={props.onCreateAfter}
        diagnostics={diagnostics()}
        onComplete={(position) =>
          props.controller.completionsFor(props.cell.id, position)
        }
        onQuickInfo={(position) =>
          props.controller.quickInfoFor(props.cell.id, position)
        }
      />
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M6 1.5v9M1.5 6h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M9.5 1.5 14.5 6.5 12.5 7.5 10.5 10.5 10.5 13 3 5.5 5.5 5.5 8.5 3.5Z M6 10 2 14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
  );
}

function focusEditor(treeItem: Element): EditorView | null {
  const content = treeItem.querySelector<HTMLElement>(
    ":scope > [data-cell-main] .cm-content",
  );
  content?.focus();
  return content ? EditorView.findFromDOM(content) : null;
}

function focusNewCellEditor(cellId: CellId): void {
  requestAnimationFrame(() => {
    const treeItem = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`);
    const view = treeItem && focusEditor(treeItem);
    if (!view) return;
    const doc = view.state.doc;
    let anchor = doc.length;
    for (let number = 1; number <= doc.lines; number += 1) {
      const line = doc.line(number);
      if (line.text.trim() === "") {
        anchor = line.to;
        break;
      }
    }
    view.dispatch({ selection: { anchor } });
  });
}

function KindChooser(props: { readonly onPick: (kind: CellKind) => void; readonly onClose: () => void }) {
  return (
    <span
      class={styles.kindChooser}
      role="group"
      aria-label="New cell kind"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          props.onClose();
        }
      }}
    >
      <For each={CELL_KINDS}>
        {(kind, index) => (
          <button
            type="button"
            class={styles.kindOption}
            ref={(button) => {
              if (index() === 0) onSettled(() => button.focus());
            }}
            onClick={(event) => {
              event.stopPropagation();
              props.onPick(kind);
            }}
          >
            {KIND_LABEL[kind]}
          </button>
        )}
      </For>
    </span>
  );
}

function CellNode(props: CellNodeProps) {
  const cell = createMemo(() => props.controller.document().cells[props.cellId]);
  const runtime = createMemo(() => props.controller.runtimeFor(props.cellId));
  const preparation = createMemo(() =>
    props.controller.preparationFor(props.cellId),
  );
  const runtimeStatus = createMemo<CellRunStatus>(
    () => runtime()?.status() ?? "idle",
  );
  const selected = () => props.view.selectedId() === props.cellId;
  const currentCell = (): Cell => {
    const current = cell();
    if (!current) {
      throw new Error(`Notebook cell ${JSON.stringify(props.cellId)} is missing`);
    }
    return current;
  };
  const label = () => currentCell().name ?? currentCell().id;
  const executable = () => currentCell().kind !== "text";
  const hasChildren = () => currentCell().children.length > 0;
  const showSource = () =>
    executable() && (selected() || props.view.isPinned(props.cellId));
  const [choosingKind, setChoosingKind] = createSignal(false);

  const createAfter = (kind: CellKind): void => {
    setChoosingKind(false);
    const placement = props.view.zoomRootId() === props.cellId ? "child" : "after";
    const created = props.controller.createCell(props.cellId, kind, placement);
    if (typeof created !== "string") return;
    props.view.select(created);
    focusNewCellEditor(created);
  };

  const saveRename = (input: HTMLInputElement): void => {
    const error = props.controller.renameCell(props.cellId, input.value);
    if (error) {
      props.view.setRenameError(props.cellId, error.message);
      return;
    }
    props.view.finishRename(props.cellId);
  };

  const handleTreeKeyDown = (event: KeyboardEvent): void => {
    const treeItem = event.currentTarget;
    if (!(treeItem instanceof HTMLElement)) return;
    if (event.target !== treeItem) {
      if (event.key === "Escape") {
        event.preventDefault();
        treeItem.focus();
      }
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      createAfter(currentCell().kind);
      return;
    }

    let destination: HTMLElement | null = null;
    let handled = false;

    if (
      event.key === "ArrowUp" ||
      event.key === "ArrowDown" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      const tree = treeItem.closest<HTMLElement>('[role="tree"]');
      const visibleItems = tree
        ? [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]
        : [];
      if (visibleItems.length === 0) return;
      handled = true;

      if (event.key === "Home") {
        destination = visibleItems[0] ?? null;
      } else if (event.key === "End") {
        destination = visibleItems.at(-1) ?? null;
      } else {
        const currentIndex = visibleItems.indexOf(treeItem);
        const nextIndex =
          event.key === "ArrowUp" ? currentIndex - 1 : currentIndex + 1;
        if (currentIndex >= 0) destination = visibleItems[nextIndex] ?? null;
      }
    } else if (event.key === "ArrowRight") {
      if (!hasChildren()) return;
      if (props.view.isCollapsed(props.cellId)) {
        props.view.toggleCollapsed(props.cellId);
        handled = true;
      } else {
        destination = treeItem.querySelector<HTMLElement>(
          ':scope > [role="group"] > [role="treeitem"]',
        );
      }
    } else if (event.key === "ArrowLeft") {
      if (hasChildren() && !props.view.isCollapsed(props.cellId)) {
        props.view.toggleCollapsed(props.cellId);
        handled = true;
      } else {
        destination =
          treeItem.parentElement?.closest<HTMLElement>('[role="treeitem"]') ??
          null;
      }
    } else if (event.key === "Enter") {
      focusEditor(treeItem);
      handled = true;
    }

    if (destination) {
      destination.focus();
      handled = true;
    }
    if (handled) event.preventDefault();
  };

  return (
    <Show when={cell()}>
      <li
        role="treeitem"
        tabindex={selected() ? 0 : -1}
        class={styles.node}
        data-cell-id={props.cellId}
        data-selected={selected() ? "" : undefined}
        aria-label={label()}
        aria-level={props.depth + 1}
        aria-selected={selected() ? "true" : "false"}
        aria-expanded={
          hasChildren()
            ? props.view.isCollapsed(props.cellId)
              ? "false"
              : "true"
            : undefined
        }
        onFocus={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('[role="treeitem"]') === event.currentTarget
          ) {
            props.view.select(props.cellId);
          }
        }}
        onKeyDown={handleTreeKeyDown}
      >
        <div
          class={styles.main}
          data-cell-main=""
          onClick={() => props.view.select(props.cellId)}
        >
          <div class={styles.gutter}>
            <Show when={hasChildren()} fallback={<span class={styles.chevronSpace} />}>
              <button
                type="button"
                class={styles.chevron}
                data-expanded={props.view.isCollapsed(props.cellId) ? undefined : ""}
                aria-label={`${
                  props.view.isCollapsed(props.cellId) ? "Expand" : "Collapse"
                } ${label()}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.view.toggleCollapsed(props.cellId);
                }}
              >
                <Chevron />
              </button>
            </Show>
            <button
              type="button"
              class={styles.bullet}
              data-status={executable() ? runtimeStatus() : undefined}
              data-collapsed={
                hasChildren() && props.view.isCollapsed(props.cellId) ? "" : undefined
              }
              aria-label={`Zoom into ${label()}`}
              title={executable() ? runtimeStatus() : undefined}
              onClick={(event) => {
                event.stopPropagation();
                props.view.zoom(props.cellId);
              }}
            />
          </div>

          <div class={styles.body}>
            <div class={styles.heading}>
              <Show
                when={props.view.renameDraft(props.cellId) !== undefined}
                fallback={
                  <span
                    class={styles.cellName}
                    title="Double-click to rename"
                    onDblClick={(event) => {
                      event.preventDefault();
                      props.view.beginRename(props.cellId, label());
                    }}
                  >
                    {label()}
                  </span>
                }
              >
                <RenameInput
                  cellId={props.cellId}
                  value={props.view.renameDraft(props.cellId) ?? ""}
                  error={props.view.renameError(props.cellId)}
                  onInput={(value) => props.view.setRenameDraft(props.cellId, value)}
                  onSave={saveRename}
                  onCancel={() => props.view.cancelRename(props.cellId)}
                />
              </Show>
              <Show when={executable()}>
                <span class={styles.kind}>{KIND_LABEL[currentCell().kind]}</span>
                <Show when={preparation()?.type}>
                  <span class={styles.inlineType} title={preparation()?.type}>
                    {preparation()?.type}
                  </span>
                </Show>
              </Show>
              <span class={styles.actions}>
                <Show when={executable()}>
                  <button
                    type="button"
                    class={styles.iconButton}
                    aria-pressed={props.view.isPinned(props.cellId) ? "true" : "false"}
                    aria-label={`${
                      props.view.isPinned(props.cellId) ? "Unpin" : "Pin"
                    } source for ${label()}`}
                    title="Keep source visible"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.view.togglePinned(props.cellId);
                    }}
                  >
                    <PinIcon />
                  </button>
                </Show>
                <Show
                  when={choosingKind()}
                  fallback={
                    <button
                      type="button"
                      class={styles.iconButton}
                      aria-label={`Add cell after ${label()}`}
                      title="Add cell (Shift+Enter)"
                      onClick={(event) => {
                        event.stopPropagation();
                        setChoosingKind(true);
                      }}
                    >
                      <PlusIcon />
                    </button>
                  }
                >
                  <KindChooser onPick={createAfter} onClose={() => setChoosingKind(false)} />
                </Show>
              </span>
            </div>

            <Show when={props.view.renameError(props.cellId)}>
              <p
                id={`rename-error-${props.cellId}`}
                class={styles.inlineError}
                role="alert"
              >
                {props.view.renameError(props.cellId)}
              </p>
            </Show>

            <Show when={!executable()}>
              <ProseSource
                cell={currentCell()}
                controller={props.controller}
                onCreateAfter={() => createAfter("text")}
              />
            </Show>

            <Show when={showSource()}>
              <ExecutableSource
                cell={currentCell()}
                controller={props.controller}
                onCreateAfter={() => createAfter(currentCell().kind)}
              />
            </Show>

            <Show when={runtimeStatus() === "error" || runtimeStatus() === "cycle"}>
              <p class={styles.runtimeError} role="alert">
                {runtime()?.error() ?? "Notebook cell failed"}
              </p>
            </Show>

            <Show when={executable()}>
              <RuntimeOutput
                kind={currentCell().kind}
                status={runtimeStatus()}
                value={runtime()?.value()}
              />
            </Show>
          </div>
        </div>

        <Show when={hasChildren() && !props.view.isCollapsed(props.cellId)}>
          <ol role="group" class={styles.children}>
            <For each={currentCell().children}>
              {(childId) => (
                <CellNode
                  cellId={childId}
                  depth={props.depth + 1}
                  controller={props.controller}
                  view={props.view}
                />
              )}
            </For>
          </ol>
        </Show>
      </li>
    </Show>
  );
}

export default function NotebookTree(props: NotebookTreeProps) {
  const document = () => props.controller.document();
  const breadcrumbs = createMemo(() =>
    breadcrumbsFor(document(), props.view.zoomRootId()),
  );
  const zoomed = () => props.view.zoomRootId() !== document().rootId;
  const rootLabel = () => {
    const root = document().cells[document().rootId];
    return root?.name ?? document().rootId;
  };

  return (
    <section class={styles.workspace} aria-label="Notebook outliner">
      <Show when={zoomed()}>
        <nav class={styles.breadcrumbs} aria-label="Notebook location">
          <For each={breadcrumbs()}>
            {(breadcrumb, index) => (
              <>
                <Show when={index() > 0}>
                  <span class={styles.breadcrumbSeparator} aria-hidden="true">
                    /
                  </span>
                </Show>
                <button
                  type="button"
                  class={styles.breadcrumbButton}
                  aria-current={
                    breadcrumb.id === props.view.zoomRootId() ? "location" : undefined
                  }
                  onClick={() => props.view.zoom(breadcrumb.id)}
                >
                  {breadcrumb.label}
                </button>
              </>
            )}
          </For>
        </nav>
      </Show>

      <ol
        role="tree"
        class={styles.tree}
        aria-label={`${rootLabel()} notebook`}
        onClick={(event) => {
          if (event.target === event.currentTarget) props.view.select(undefined);
        }}
      >
        <CellNode
          cellId={props.view.zoomRootId()}
          depth={0}
          controller={props.controller}
          view={props.view}
        />
      </ol>
    </section>
  );
}
