import type { CellId, NotebookDocument } from "../model/types";
import type {
  NotebookPath,
  PathResolution,
  SourceSpan,
} from "./analysis-types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function cellRecord(
  cells: UnknownRecord,
  cellId: CellId,
): UnknownRecord | undefined {
  return asRecord(cells[cellId]);
}

function parentCandidates(
  cells: UnknownRecord,
  cellId: CellId,
): readonly CellId[] {
  const parents: CellId[] = [];

  for (const [candidateId, value] of Object.entries(cells)) {
    const candidate = asRecord(value);
    if (!candidate || !Array.isArray(candidate.children)) {
      continue;
    }
    if (
      candidate.children.some((childId) => childId === cellId) &&
      !parents.includes(candidateId)
    ) {
      parents.push(candidateId);
    }
  }

  return parents;
}

export function resolveNotebookPath(
  document: NotebookDocument,
  analyzedCellId: CellId,
  path: NotebookPath,
): PathResolution {
  const cells = asRecord(document.cells);
  if (!cells || !cellRecord(cells, analyzedCellId)) {
    return {
      status: "invalid",
      reason: "analyzed-cell-missing",
      span: path.origin.span,
    };
  }

  let currentId: CellId;
  switch (path.origin.kind) {
    case "self":
      currentId = analyzedCellId;
      break;
    case "root": {
      const rootId: unknown = document.rootId;
      if (
        typeof rootId !== "string" ||
        rootId.length === 0 ||
        !cellRecord(cells, rootId)
      ) {
        return {
          status: "invalid",
          reason: "root-missing",
          span: path.origin.span,
        };
      }
      currentId = rootId;
      break;
    }
    case "parent": {
      const candidates = parentCandidates(cells, analyzedCellId);
      if (candidates.length === 0) {
        return { status: "missing", at: "parent", span: path.origin.span };
      }
      if (candidates.length > 1) {
        return {
          status: "ambiguous",
          at: "parent",
          span: path.origin.span,
          candidateIds: candidates,
        };
      }
      const parentId = candidates[0];
      if (parentId === undefined) {
        return { status: "missing", at: "parent", span: path.origin.span };
      }
      currentId = parentId;
      break;
    }
  }

  let expectsNamedChild = false;
  let childrenSpan: SourceSpan | undefined;

  for (const hop of path.hops) {
    if (hop.kind === "children") {
      if (expectsNamedChild) {
        return {
          status: "invalid",
          reason: "children-segment-without-name",
          span: hop.span,
        };
      }
      expectsNamedChild = true;
      childrenSpan = hop.span;
      continue;
    }

    if (hop.kind === "dynamic") {
      return { status: "dynamic", span: hop.span };
    }

    const current = cellRecord(cells, currentId);
    if (!current || !Array.isArray(current.children)) {
      return {
        status: "invalid",
        reason: "cell-children-invalid",
        span: hop.span,
      };
    }

    const candidates: CellId[] = [];
    for (const childId of current.children) {
      if (typeof childId !== "string") {
        continue;
      }
      const child = cellRecord(cells, childId);
      if (
        child?.name === hop.name &&
        !candidates.includes(childId)
      ) {
        candidates.push(childId);
      }
    }

    if (candidates.length === 0) {
      return {
        status: "missing",
        at: "child",
        fromId: currentId,
        name: hop.name,
        span: hop.span,
      };
    }
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        at: "child",
        fromId: currentId,
        name: hop.name,
        span: hop.span,
        candidateIds: candidates,
      };
    }

    const candidate = candidates[0];
    if (candidate === undefined) {
      return {
        status: "missing",
        at: "child",
        fromId: currentId,
        name: hop.name,
        span: hop.span,
      };
    }
    currentId = candidate;
    expectsNamedChild = false;
    childrenSpan = undefined;
  }

  if (expectsNamedChild) {
    return {
      status: "invalid",
      reason: "children-segment-without-name",
      span: childrenSpan ?? path.valueSpan,
    };
  }

  return { status: "resolved", targetId: currentId };
}
