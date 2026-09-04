import type { Cell, CellId, NotebookDocument } from "../model/types";
import type { NotebookGraphResult } from "./analysis-types";
import {
  buildNotebookDependencyGraph,
  downstreamClosure,
} from "./dependency-graph";
import { buildNotebookReadHandles } from "./read-handles";
import type { RuntimeContext } from "./read-handles";
import type { CellRuntimeRegistry } from "./registry";
import {
  ensureCellRuntime,
  synchronizeRuntimeRegistry,
} from "./registry";
import type { CellPreparer, PreparedCell } from "./prepare";
import { prepareCellSynchronously } from "./prepare";

export const CALLBACK_REQUIRED_ERROR =
  "Cell must call $() or md() with a callback";
export const ASYNC_RESULT_ERROR = "Async cell results are not supported yet";
export const MARKDOWN_RESULT_ERROR = "md() callback must return a string";

export interface NotebookExecutionOptions {
  readonly prepared?: ReadonlyMap<CellId, PreparedCell>;
  readonly prepare?: CellPreparer;
  readonly changedIds?: Iterable<CellId>;
}

export interface NotebookTransactionResult {
  readonly graph: NotebookGraphResult;
  readonly affectedIds: readonly CellId[];
  readonly executedIds: readonly CellId[];
}

function isExecutable(cell: Cell): boolean {
  return cell.kind === "javascript" || cell.kind === "markdown";
}

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    !("then" in value)
  ) {
    return false;
  }
  return typeof value.then === "function";
}

function preparationFor(
  document: NotebookDocument,
  cell: Cell,
  graph: NotebookGraphResult,
  options: NotebookExecutionOptions,
): PreparedCell {
  const supplied = options.prepared?.get(cell.id);
  if (
    supplied &&
    supplied.cellId === cell.id &&
    supplied.kind === cell.kind &&
    supplied.source === cell.source
  ) {
    return supplied;
  }

  const analysis = graph.analyses.get(cell.id);
  if (!analysis) {
    throw new Error(`Missing dependency analysis for cell: ${cell.id}`);
  }
  return (options.prepare ?? prepareCellSynchronously)(
    document,
    cell,
    analysis,
  );
}

function executePreparedCell(
  cell: Cell,
  prepared: Extract<PreparedCell, { readonly ok: true }>,
  context: RuntimeContext,
): unknown {
  const expectedHelper = cell.kind === "markdown" ? "md" : "$";
  let invocationCount = 0;
  let callbackResult: unknown;

  const invoke = (helper: "$" | "md", arguments_: readonly unknown[]): unknown => {
    invocationCount += 1;
    const callback = arguments_[0];
    if (
      invocationCount !== 1 ||
      helper !== expectedHelper ||
      arguments_.length !== 1 ||
      typeof callback !== "function"
    ) {
      throw new Error(CALLBACK_REQUIRED_ERROR);
    }
    callbackResult = callback(context);
    return callbackResult;
  };

  const dollar = (...arguments_: unknown[]): unknown => invoke("$", arguments_);
  const markdown = (...arguments_: unknown[]): unknown => invoke("md", arguments_);

  // Trusted notebook code executes in the page realm. Function is explicitly
  // an unsandboxed execution boundary, not isolation for untrusted programs.
  const evaluate = new Function("$", "md", prepared.code) as (
    dollarHelper: typeof dollar,
    markdownHelper: typeof markdown,
  ) => unknown;
  evaluate(dollar, markdown);

  if (invocationCount !== 1) {
    throw new Error(CALLBACK_REQUIRED_ERROR);
  }
  if (isThenable(callbackResult)) {
    throw new Error(ASYNC_RESULT_ERROR);
  }
  if (cell.kind === "markdown" && typeof callbackResult !== "string") {
    throw new Error(MARKDOWN_RESULT_ERROR);
  }
  return callbackResult;
}

export function executeNotebookTransaction(
  document: NotebookDocument,
  registry: CellRuntimeRegistry,
  options: NotebookExecutionOptions = {},
): NotebookTransactionResult {
  synchronizeRuntimeRegistry(registry, document);
  const graph = buildNotebookDependencyGraph(document);
  const affectedIds = Object.hasOwn(options, "changedIds")
    ? downstreamClosure(graph, options.changedIds ?? [])
    : graph.order;
  const affected = new Set(affectedIds);
  const handles = buildNotebookReadHandles(document, registry);

  for (const cellId of affectedIds) {
    const cell = document.cells[cellId];
    if (cell && isExecutable(cell)) {
      ensureCellRuntime(registry, cellId).begin();
    }
  }

  const cycleBlocked = new Set([
    ...graph.cycleMembers,
    ...graph.blockedByCycles,
  ]);
  for (const cellId of graph.order) {
    if (affected.has(cellId) && cycleBlocked.has(cellId)) {
      ensureCellRuntime(registry, cellId).markCycle();
    }
  }

  const executedIds: CellId[] = [];
  for (const layer of graph.layers) {
    for (const cellId of layer) {
      if (!affected.has(cellId)) {
        continue;
      }
      const cell = document.cells[cellId];
      if (!cell || !isExecutable(cell)) {
        continue;
      }

      const runtime = ensureCellRuntime(registry, cellId);
      executedIds.push(cellId);
      try {
        const prepared = preparationFor(document, cell, graph, options);
        if (!prepared.ok) {
          runtime.fail(prepared.error.message);
          continue;
        }
        const value = executePreparedCell(
          cell,
          prepared,
          handles.contextFor(cellId),
        );
        runtime.publish(value);
      } catch (error) {
        runtime.fail(error);
      }
    }
  }

  return Object.freeze({
    graph,
    affectedIds: Object.freeze([...affectedIds]),
    executedIds: Object.freeze(executedIds),
  });
}
