import type { CellId, NotebookDocument } from "../model/types";

export interface Breadcrumb {
  readonly id: CellId;
  readonly label: string;
}

export function breadcrumbsFor(
  document: NotebookDocument,
  targetId: CellId,
): readonly Breadcrumb[] {
  if (!Object.hasOwn(document.cells, targetId)) {
    return [];
  }

  const parents = new Map<CellId, CellId>();
  for (const cell of Object.values(document.cells)) {
    for (const childId of cell.children) {
      if (!parents.has(childId)) {
        parents.set(childId, cell.id);
      }
    }
  }

  const path: Breadcrumb[] = [];
  const visited = new Set<CellId>();
  let currentId: CellId | undefined = targetId;
  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    const cell = document.cells[currentId];
    if (!cell) break;
    path.push({ id: currentId, label: cell.name ?? cell.id });
    currentId = parents.get(currentId);
  }
  path.reverse();

  return path[0]?.id === document.rootId ? path : [];
}
