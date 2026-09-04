import type { CellId, CellKind, NotebookDocument } from "../model/types";
import type {
  CellDependencyAnalysis,
  DependencyIssue,
} from "../runtime/analysis-types";

export type PreparedCellStatus =
  | "text"
  | "explicit"
  | "inferred"
  | "invalid"
  | "cycle";

export type CellPreparationErrorCode =
  | "INVALID_TYPESCRIPT"
  | "IMPORT_UNSUPPORTED"
  | "MODULE_SYNTAX_UNSUPPORTED"
  | "TOP_LEVEL_AWAIT_UNSUPPORTED";

export interface CellPreparationError {
  readonly code: CellPreparationErrorCode;
  readonly message: string;
}

interface PreparedCellBase {
  readonly cellId: CellId;
  readonly kind: CellKind;
  readonly source: string;
  readonly dependencies: readonly CellId[];
  readonly analysis: CellDependencyAnalysis;
  readonly issues: readonly DependencyIssue[];
  readonly type: string;
  readonly status: PreparedCellStatus;
}

export type PreparedCell =
  | (PreparedCellBase & {
      readonly ok: true;
      readonly code: string;
    })
  | (PreparedCellBase & {
      readonly ok: false;
      readonly error: CellPreparationError;
    });

export interface PreparedGraph {
  readonly order: readonly CellId[];
  readonly dependencies: Readonly<Record<CellId, readonly CellId[]>>;
  readonly dependents: Readonly<Record<CellId, readonly CellId[]>>;
  readonly layers: readonly (readonly CellId[])[];
  readonly cycleGroups: readonly (readonly CellId[])[];
  readonly cycleMembers: readonly CellId[];
  readonly blockedByCycles: readonly CellId[];
}

export interface FastPreparationTimings {
  readonly totalMs: number;
  readonly analysisMs: number;
  readonly transpileMs: number;
  readonly cellCount: number;
  readonly reusedCells: number;
  readonly transpiledCells: number;
}

export interface PreparedNotebook {
  readonly revision: string;
  readonly cells: readonly PreparedCell[];
  readonly graph: PreparedGraph;
  readonly timings: FastPreparationTimings;
}

export interface FastPrepareRequest {
  readonly type: "prepare";
  readonly requestId: string;
  readonly revision: string;
  readonly document: NotebookDocument;
}

export interface FastPrepareSuccess {
  readonly type: "prepared";
  readonly requestId: string;
  readonly revision: string;
  readonly prepared: PreparedNotebook;
}

export interface FastPrepareFailure {
  readonly type: "failed";
  readonly requestId: string;
  readonly revision: string;
  readonly error: {
    readonly message: string;
  };
}

export type FastPrepareResponse = FastPrepareSuccess | FastPrepareFailure;

const revisionByDocument = new WeakMap<NotebookDocument, string>();

export function revisionForDocument(document: NotebookDocument): string {
  const cached = revisionByDocument.get(document);
  if (cached !== undefined) {
    return cached;
  }
  const revision = JSON.stringify(document);
  revisionByDocument.set(document, revision);
  return revision;
}

export function preparedDownstreamClosure(
  graph: PreparedGraph,
  changedIds: Iterable<CellId>,
): readonly CellId[] {
  const affected = new Set<CellId>();
  const pending: CellId[] = [];

  for (const cellId of changedIds) {
    if (Object.hasOwn(graph.dependents, cellId) && !affected.has(cellId)) {
      affected.add(cellId);
      pending.push(cellId);
    }
  }

  for (let index = 0; index < pending.length; index += 1) {
    const cellId = pending[index];
    if (cellId === undefined) {
      continue;
    }
    for (const dependentId of graph.dependents[cellId] ?? []) {
      if (!affected.has(dependentId)) {
        affected.add(dependentId);
        pending.push(dependentId);
      }
    }
  }

  return graph.order.filter((cellId) => affected.has(cellId));
}
