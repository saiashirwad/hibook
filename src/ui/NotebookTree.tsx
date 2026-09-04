import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { Cell, CellId, CellKind } from "../model/types";
import type { CellRunStatus } from "../runtime/registry";
import CodeEditor from "./CodeEditor";
import { formatValue } from "./format-value";
import type { NotebookController } from "./notebook-controller";
import { renderMarkdown } from "./render-markdown";
import { breadcrumbsFor } from "./tree-helpers";
import type { NotebookViewState, DisclosurePanel } from "./view-state";
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
  readonly onSave: (input: HTMLInputElement, blurAfterSave: boolean) => boolean;
  readonly onCancel: (input: HTMLInputElement) => void;
  readonly onBlur: (input: HTMLInputElement) => void;
}

interface RuntimeOutputProps {
  readonly kind: CellKind;
  readonly status: CellRunStatus;
  readonly value: unknown;
}

interface SourceEditorProps {
  readonly cell: Cell;
  readonly controller: NotebookController;
}

const KIND_LABEL: Record<CellKind, string> = {
  text: "prose",
  javascript: "javascript",
  markdown: "markdown",
};

const PANEL_LABEL: Record<DisclosurePanel, string> = {
  source: "SRC",
  output: "OUT",
  type: "TYPE",
};

function RenameInput(props: RenameInputProps) {
  let input: HTMLInputElement | undefined;

  onSettled(() => {
    input?.focus();
    input?.select();
  });

  return (
    <span class={styles.renameEditor}>
      <input
        ref={(element) => {
          input = element;
        }}
        class={styles.renameInput}
        value={props.value}
        aria-label={`Programmatic name for ${props.cellId}`}
        aria-invalid={props.error === undefined ? "false" : "true"}
        aria-describedby={
          props.error === undefined ? undefined : `rename-error-${props.cellId}`
        }
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onBlur={(event) => props.onBlur(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onSave(event.currentTarget, true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel(event.currentTarget);
          }
        }}
      />
      <button
        type="button"
        class={styles.renameButton}
        aria-label={`Save name for ${props.cellId}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          if (input) props.onSave(input, true);
        }}
      >
        Save
      </button>
      <button
        type="button"
        class={styles.renameButton}
        aria-label={`Cancel rename for ${props.cellId}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          if (input) props.onCancel(input);
        }}
      >
        Cancel
      </button>
    </span>
  );
}

function RuntimeOutput(props: RuntimeOutputProps) {
  const markdownHtml = createMemo(() =>
    props.kind === "markdown" && typeof props.value === "string"
      ? renderMarkdown(props.value)
      : undefined,
  );
  const formattedValue = createMemo(() => formatValue(props.value));

  return (
    <Show
      when={props.status === "success"}
      fallback={
        <Show when={props.status === "idle" || props.status === "pending"}>
          <p class={styles.pendingOutput}>Waiting for execution…</p>
        </Show>
      }
    >
      <Show
        when={markdownHtml() !== undefined}
        fallback={<pre class={styles.valueOutput}>{formattedValue()}</pre>}
      >
        <div
          class={styles.markdownOutput}
          data-markdown-output=""
          innerHTML={markdownHtml() ?? ""}
        />
      </Show>
    </Show>
  );
}

function ProseSource(props: SourceEditorProps) {
  const [editing, setEditing] = createSignal(false);
  const previewHtml = createMemo(() => renderMarkdown(props.cell.source));
  const enterEditMode = () => setEditing(true);

  return (
    <div class={styles.proseHost} data-prose-editor={props.cell.id}>
      <div
        class={`${styles.proseLayer} ${styles.prosePreview} ${
          editing() ? styles.inactiveLayer : ""
        }`}
        role="button"
        tabindex={editing() ? -1 : 0}
        aria-label={`Edit prose for ${props.cell.id}`}
        aria-hidden={editing() ? "true" : "false"}
        innerHTML={previewHtml()}
        onClick={(event) => {
          event.preventDefault();
          enterEditMode();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            enterEditMode();
          }
        }}
      />
      <div
        class={`${styles.proseLayer} ${styles.proseEditor} ${
          editing() ? "" : styles.inactiveLayer
        }`}
        aria-hidden={editing() ? "false" : "true"}
      >
        <CodeEditor
          source={props.cell.source}
          kind="text"
          ariaLabel={`Prose source for ${props.cell.id}`}
          focused={editing()}
          onChange={(source) =>
            props.controller.updateCellSource(props.cell.id, source)
          }
          onRun={() => props.controller.runCell(props.cell.id)}
          onBlur={() => setEditing(false)}
        />
      </div>
    </div>
  );
}

function ExecutableSource(props: SourceEditorProps) {
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
        diagnostics={
          props.controller.semanticFor(props.cell.id).result?.diagnostics ?? []
        }
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

function DisclosureButton(props: {
  readonly cellId: CellId;
  readonly cellKind: CellKind;
  readonly panel: DisclosurePanel;
  readonly view: NotebookViewState;
}) {
  return (
    <button
      type="button"
      class={styles.disclosureButton}
      aria-label={`${
        props.view.isDisclosureOpen(props.cellId, props.panel, props.cellKind)
          ? "Hide"
          : "Show"
      } ${props.panel} for ${props.cellId}`}
      aria-pressed={
        props.view.isDisclosureOpen(
          props.cellId,
          props.panel,
          props.cellKind,
        )
          ? "true"
          : "false"
      }
      onClick={(event) => {
        event.stopPropagation();
        props.view.toggleDisclosure(
          props.cellId,
          props.panel,
          props.cellKind,
        );
      }}
    >
      {PANEL_LABEL[props.panel]}
    </button>
  );
}

function CellNode(props: CellNodeProps) {
  const cell = createMemo(() => props.controller.document().cells[props.cellId]);
  const runtime = createMemo(() => props.controller.runtimeFor(props.cellId));
  const preparation = createMemo(() =>
    props.controller.preparationFor(props.cellId),
  );
  const semantic = createMemo(() =>
    props.controller.semanticFor(props.cellId),
  );
  const runtimeStatus = createMemo<CellRunStatus>(
    () => runtime()?.status() ?? "idle",
  );
  const currentCell = (): Cell => {
    const current = cell();
    if (!current) {
      throw new Error(`Notebook cell ${JSON.stringify(props.cellId)} is missing`);
    }
    return current;
  };
  const suppressBlur = new Set<HTMLInputElement>();

  const saveRename = (input: HTMLInputElement, blurAfterSave: boolean): boolean => {
    const error = props.controller.renameCell(props.cellId, input.value);
    if (error) {
      props.view.setRenameError(props.cellId, error.message);
      return false;
    }

    props.view.finishRename(props.cellId);
    if (blurAfterSave) {
      suppressBlur.add(input);
      input.blur();
    }
    return true;
  };

  return (
    <Show when={cell()}>
      <li
          role="none"
          class={
            props.view.selectedId() === props.cellId
              ? `${styles.node} ${styles.selected}`
              : styles.node
          }
        >
          <div
            role="treeitem"
            tabindex="0"
            class={styles.main}
            aria-level={props.depth + 1}
            aria-selected={
              props.view.selectedId() === props.cellId ? "true" : "false"
            }
            aria-expanded={
              currentCell().children.length === 0
                ? false
                : props.view.isCollapsed(props.cellId)
                  ? "false"
                  : "true"
            }
            onFocus={() => props.view.select(props.cellId)}
            onClick={() => props.view.select(props.cellId)}
          >
            <div class={styles.cellHeading}>
              <Show
                when={currentCell().children.length > 0}
                fallback={<span class={styles.bullet} aria-hidden="true" />}
              >
                <button
                  type="button"
                  class={styles.collapseButton}
                  aria-label={`${
                    props.view.isCollapsed(props.cellId) ? "Expand" : "Collapse"
                  } ${currentCell().name ?? currentCell().id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.view.toggleCollapsed(props.cellId);
                  }}
                >
                  <span aria-hidden="true">
                    {props.view.isCollapsed(props.cellId) ? "›" : "⌄"}
                  </span>
                </button>
              </Show>

              <div class={styles.identity}>
                <Show
                  when={props.view.renameDraft(props.cellId) !== undefined}
                  fallback={
                    <span class={styles.cellName}>
                      {currentCell().name ?? currentCell().id}
                    </span>
                  }
                >
                  <RenameInput
                    cellId={props.cellId}
                    value={props.view.renameDraft(props.cellId) ?? ""}
                    error={props.view.renameError(props.cellId)}
                    onInput={(value) =>
                      props.view.setRenameDraft(props.cellId, value)
                    }
                    onSave={saveRename}
                    onCancel={(input) => {
                      suppressBlur.add(input);
                      props.view.cancelRename(props.cellId);
                      input.blur();
                    }}
                    onBlur={(input) => {
                      if (suppressBlur.delete(input)) return;
                      saveRename(input, false);
                    }}
                  />
                </Show>
                <span class={styles.kind}>{KIND_LABEL[currentCell().kind]}</span>
                <Show when={preparation()?.type}>
                  <span class={styles.inlineType}>{preparation()?.type}</span>
                </Show>
                <Show when={currentCell().kind !== "text"}>
                  <span
                    class={`${styles.runStatus} ${styles[`status-${runtimeStatus()}`]}`}
                    aria-label={`Execution status: ${runtimeStatus()}`}
                  >
                    {runtimeStatus()}
                    <Show when={runtime()?.version()}>
                      {" · run "}
                      {runtime()?.version()}
                    </Show>
                  </span>
                </Show>
              </div>

              <div class={styles.actions} role="group" aria-label="Cell actions">
                <For each={["source", "output", "type"] as const}>
                  {(panel) => (
                    <DisclosureButton
                      cellId={props.cellId}
                      cellKind={currentCell().kind}
                      panel={panel}
                      view={props.view}
                    />
                  )}
                </For>
                <button
                  type="button"
                  class={styles.actionButton}
                  aria-label={`Rename ${currentCell().name ?? currentCell().id}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.view.beginRename(
                      props.cellId,
                      currentCell().name ?? currentCell().id,
                    );
                  }}
                >
                  Rename
                </button>
                <Show when={props.view.zoomRootId() !== props.cellId}>
                  <button
                    type="button"
                    class={styles.actionButton}
                    aria-label={`Zoom to ${currentCell().name ?? currentCell().id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.view.zoom(props.cellId);
                    }}
                  >
                    Zoom
                  </button>
                </Show>
              </div>
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

            <Show
              when={props.view.isDisclosureOpen(
                props.cellId,
                "source",
                currentCell().kind,
              )}
            >
              <Show
                when={currentCell().kind === "text"}
                fallback={
                  <ExecutableSource
                    cell={currentCell()}
                    controller={props.controller}
                  />
                }
              >
                <ProseSource
                  cell={currentCell()}
                  controller={props.controller}
                />
              </Show>
            </Show>

            <Show
              when={
                runtimeStatus() === "error" || runtimeStatus() === "cycle"
              }
            >
              <p class={styles.runtimeError} role="alert">
                {runtime()?.error() ?? "Notebook cell failed"}
              </p>
            </Show>

            <Show
              when={props.view.isDisclosureOpen(
                props.cellId,
                "output",
                currentCell().kind,
              )}
            >
              <RuntimeOutput
                kind={currentCell().kind}
                status={runtimeStatus()}
                value={runtime()?.value()}
              />
            </Show>

            <Show
              when={props.view.isDisclosureOpen(
                props.cellId,
                "type",
                currentCell().kind,
              )}
            >
              <div
                class={styles.typePanel}
                data-semantic-status={semantic().status}
              >
                <p>
                  Type ({semantic().status}):{" "}
                  <code>
                    {semantic().result?.type ?? preparation()?.type ?? "pending"}
                  </code>
                </p>
                <Show
                  when={
                    semantic().result?.diagnostics.length
                      ? semantic().result?.diagnostics
                      : preparation()?.issues
                  }
                >
                  <ul>
                    <For
                      each={
                        semantic().result?.diagnostics.length
                          ? semantic().result?.diagnostics
                          : preparation()?.issues ?? []
                      }
                    >
                      {(issue) => <li>{issue.message}</li>}
                    </For>
                  </ul>
                </Show>
              </div>
            </Show>
          </div>

          <Show
            when={
              currentCell().children.length > 0 &&
              !props.view.isCollapsed(props.cellId)
            }
          >
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
  const breadcrumbs = createMemo(() =>
    breadcrumbsFor(props.controller.document(), props.view.zoomRootId()),
  );

  return (
    <section class={styles.workspace} aria-label="Notebook outliner">
      <nav class={styles.breadcrumbs} aria-label="Notebook location">
        <For each={breadcrumbs()}>
          {(breadcrumb, index) => (
            <span class={styles.breadcrumbItem}>
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
            </span>
          )}
        </For>
      </nav>

      <ol role="tree" class={styles.tree} aria-label="Tiny Commerce notebook">
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
