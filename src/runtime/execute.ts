import type { Cell, CellId, NotebookDocument } from "../model/types";
import type { PreparedCell, PreparedNotebook } from "../compiler/protocol";
import { revisionForDocument } from "../compiler/protocol";
import type { NotebookGraphResult } from "./analysis-types";
import { buildNotebookReadHandles } from "./read-handles";
import type { RuntimeContext } from "./read-handles";
import type { CellRuntimeRegistry } from "./registry";
import {
  ensureCellRuntime,
  synchronizeRuntimeRegistry,
} from "./registry";

export const CALLBACK_REQUIRED_ERROR =
  "Cell must call $() or md() with a callback";
export const ASYNC_RESULT_ERROR = "Async cell results are not supported yet";
export const MARKDOWN_RESULT_ERROR = "md() callback must return a string";
export const PREPARED_REVISION_MISMATCH_ERROR =
  "Prepared notebook revision does not match the document";

export type NotebookPreparer = (
  document: NotebookDocument,
) => PreparedNotebook;

interface NotebookExecutionOptionsBase {
  readonly changedIds?: Iterable<CellId>;
}

export type NotebookExecutionOptions = NotebookExecutionOptionsBase &
  (
    | {
        readonly prepared: PreparedNotebook;
        readonly prepare?: never;
      }
    | {
        readonly prepared?: never;
        readonly prepare: NotebookPreparer;
      }
  );

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

function runtimeGraph(prepared: PreparedNotebook): NotebookGraphResult {
  const analyses = new Map(
    prepared.cells.map((cell) => [cell.cellId, cell.analysis] as const),
  );
  const dependencies = new Map(
    prepared.graph.order.map(
      (cellId) => [cellId, prepared.graph.dependencies[cellId] ?? []] as const,
    ),
  );
  const dependents = new Map(
    prepared.graph.order.map(
      (cellId) => [cellId, prepared.graph.dependents[cellId] ?? []] as const,
    ),
  );
  return {
    order: prepared.graph.order,
    analyses,
    dependencies,
    dependents,
    layers: prepared.graph.layers,
    cycleGroups: prepared.graph.cycleGroups.map((cellIds) => ({ cellIds })),
    cycleMembers: prepared.graph.cycleMembers,
    blockedByCycles: prepared.graph.blockedByCycles,
  };
}

function downstreamClosure(
  graph: NotebookGraphResult,
  changedIds: Iterable<CellId>,
): readonly CellId[] {
  const affected = new Set<CellId>();
  const pending: CellId[] = [];
  for (const cellId of changedIds) {
    if (graph.dependents.has(cellId) && !affected.has(cellId)) {
      affected.add(cellId);
      pending.push(cellId);
    }
  }
  for (let index = 0; index < pending.length; index += 1) {
    const cellId = pending[index];
    if (cellId === undefined) {
      continue;
    }
    for (const dependentId of graph.dependents.get(cellId) ?? []) {
      if (!affected.has(dependentId)) {
        affected.add(dependentId);
        pending.push(dependentId);
      }
    }
  }
  return graph.order.filter((cellId) => affected.has(cellId));
}

function preparationFor(
  cell: Cell,
  preparedCells: ReadonlyMap<CellId, PreparedCell>,
): PreparedCell {
  const prepared = preparedCells.get(cell.id);
  if (
    !prepared ||
    prepared.cellId !== cell.id ||
    prepared.kind !== cell.kind ||
    prepared.source !== cell.source
  ) {
    throw new Error(`Missing exact prepared output for cell: ${cell.id}`);
  }
  return prepared;
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
  options: NotebookExecutionOptions,
): NotebookTransactionResult {
  const prepared = options.prepared ?? options.prepare?.(document);
  if (!prepared) {
    throw new Error("Notebook execution requires prepared compiler output");
  }
  if (prepared.revision !== revisionForDocument(document)) {
    throw new Error(PREPARED_REVISION_MISMATCH_ERROR);
  }

  synchronizeRuntimeRegistry(registry, document);
  const graph = runtimeGraph(prepared);
  const preparedCells = new Map(
    prepared.cells.map((cell) => [cell.cellId, cell] as const),
  );
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
        const preparedCell = preparationFor(cell, preparedCells);
        if (!preparedCell.ok) {
          runtime.fail(preparedCell.error.message);
          continue;
        }
        const value = executePreparedCell(
          cell,
          preparedCell,
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
