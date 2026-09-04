import type { Cell, CellId, NotebookDocument } from "../model/types";
import type {
  CellDependencyAnalysis,
  DependencyCycleGroup,
  NotebookGraphResult,
} from "./analysis-types";
import { analyzeCellDependencies } from "./analyze-dependencies";

function documentOrder(document: NotebookDocument): readonly CellId[] {
  const order: CellId[] = [];
  const visited = new Set<CellId>();
  const cells = document.cells;

  const visit = (cellId: CellId): void => {
    if (visited.has(cellId) || !Object.hasOwn(cells, cellId)) {
      return;
    }
    visited.add(cellId);
    order.push(cellId);

    const cell = cells[cellId] as Cell | undefined;
    if (!cell || !Array.isArray(cell.children)) {
      return;
    }
    for (const childId of cell.children) {
      if (typeof childId === "string") {
        visit(childId);
      }
    }
  };

  if (typeof document.rootId === "string") {
    visit(document.rootId);
  }
  for (const cellId of Object.keys(cells)) {
    visit(cellId);
  }
  return order;
}

function stronglyConnectedGroups(
  order: readonly CellId[],
  dependencies: ReadonlyMap<CellId, readonly CellId[]>,
): readonly DependencyCycleGroup[] {
  const indexById = new Map<CellId, number>();
  const lowLinkById = new Map<CellId, number>();
  const stack: CellId[] = [];
  const onStack = new Set<CellId>();
  const groups: CellId[][] = [];
  let nextIndex = 0;

  const connect = (cellId: CellId): void => {
    const currentIndex = nextIndex;
    nextIndex += 1;
    indexById.set(cellId, currentIndex);
    lowLinkById.set(cellId, currentIndex);
    stack.push(cellId);
    onStack.add(cellId);

    for (const dependencyId of dependencies.get(cellId) ?? []) {
      if (!indexById.has(dependencyId)) {
        connect(dependencyId);
        const dependencyLowLink = lowLinkById.get(dependencyId);
        const currentLowLink = lowLinkById.get(cellId);
        if (
          dependencyLowLink !== undefined &&
          currentLowLink !== undefined &&
          dependencyLowLink < currentLowLink
        ) {
          lowLinkById.set(cellId, dependencyLowLink);
        }
      } else if (onStack.has(dependencyId)) {
        const dependencyIndex = indexById.get(dependencyId);
        const currentLowLink = lowLinkById.get(cellId);
        if (
          dependencyIndex !== undefined &&
          currentLowLink !== undefined &&
          dependencyIndex < currentLowLink
        ) {
          lowLinkById.set(cellId, dependencyIndex);
        }
      }
    }

    if (lowLinkById.get(cellId) !== indexById.get(cellId)) {
      return;
    }

    const group: CellId[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) {
        break;
      }
      onStack.delete(member);
      group.push(member);
      if (member === cellId) {
        break;
      }
    }

    const isSelfCycle =
      group.length === 1 &&
      (dependencies.get(group[0] ?? "") ?? []).includes(group[0] ?? "");
    if (group.length > 1 || isSelfCycle) {
      groups.push(group);
    }
  };

  for (const cellId of order) {
    if (!indexById.has(cellId)) {
      connect(cellId);
    }
  }

  const position = new Map(order.map((cellId, index) => [cellId, index]));
  for (const group of groups) {
    group.sort(
      (left, right) =>
        (position.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(right) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  groups.sort(
    (left, right) =>
      (position.get(left[0] ?? "") ?? Number.MAX_SAFE_INTEGER) -
      (position.get(right[0] ?? "") ?? Number.MAX_SAFE_INTEGER),
  );

  return groups.map((cellIds) => ({ cellIds }));
}

interface LayerResult {
  readonly layers: readonly (readonly CellId[])[];
  readonly blockedByCycles: readonly CellId[];
}

function topologicalLayers(
  order: readonly CellId[],
  dependencies: ReadonlyMap<CellId, readonly CellId[]>,
  cycleMembers: ReadonlySet<CellId>,
): LayerResult {
  const processed = new Set<CellId>();
  const remaining = new Set(
    order.filter((cellId) => !cycleMembers.has(cellId)),
  );
  const layers: CellId[][] = [];

  while (remaining.size > 0) {
    const layer = order.filter(
      (cellId) =>
        remaining.has(cellId) &&
        (dependencies.get(cellId) ?? []).every((dependencyId) =>
          processed.has(dependencyId),
        ),
    );
    if (layer.length === 0) {
      break;
    }
    layers.push(layer);
    for (const cellId of layer) {
      remaining.delete(cellId);
      processed.add(cellId);
    }
  }

  return {
    layers,
    blockedByCycles: order.filter((cellId) => remaining.has(cellId)),
  };
}

export function buildNotebookDependencyGraph(
  document: NotebookDocument,
  reusableAnalyses?: ReadonlyMap<CellId, CellDependencyAnalysis>,
): NotebookGraphResult {
  const order = documentOrder(document);
  const analyses = new Map<CellId, CellDependencyAnalysis>();
  const dependencies = new Map<CellId, readonly CellId[]>();

  for (const cellId of order) {
    const cell = document.cells[cellId];
    if (!cell) {
      continue;
    }
    const analysis =
      reusableAnalyses?.get(cellId) ?? analyzeCellDependencies(document, cell);
    analyses.set(cellId, analysis);
    dependencies.set(cellId, analysis.dependencies);
  }

  const dependents = new Map<CellId, CellId[]>();
  for (const cellId of order) {
    dependents.set(cellId, []);
  }
  for (const cellId of order) {
    for (const dependencyId of dependencies.get(cellId) ?? []) {
      const reverse = dependents.get(dependencyId);
      if (reverse && !reverse.includes(cellId)) {
        reverse.push(cellId);
      }
    }
  }

  const cycleGroups = stronglyConnectedGroups(order, dependencies);
  const cycleSet = new Set(
    cycleGroups.flatMap((group) => group.cellIds),
  );
  const cycleMembers = order.filter((cellId) => cycleSet.has(cellId));
  const { layers, blockedByCycles } = topologicalLayers(
    order,
    dependencies,
    cycleSet,
  );

  return {
    order,
    analyses,
    dependencies,
    dependents,
    layers,
    cycleGroups,
    cycleMembers,
    blockedByCycles,
  };
}

export function downstreamClosure(
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
