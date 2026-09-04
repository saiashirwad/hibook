import { createSignal, onSettled } from "solid-js";
import type { Accessor } from "solid-js";
import { IndexedDbNotebookCache } from "../cache/indexeddb";
import type { NotebookCache } from "../cache/indexeddb";
import {
  ExecutionPreparationScheduler,
  FastPreparationCoordinator,
} from "../compiler/coordinator";
import type { PreparedCell, PreparedNotebook } from "../compiler/protocol";
import {
  preparedDownstreamClosure,
  revisionForDocument,
} from "../compiler/protocol";
import {
  SemanticCoordinator,
  SemanticInferenceScheduler,
  SemanticScheduleCancelledError,
  SemanticScheduleReplacedError,
  StaleSemanticRequestError,
} from "../compiler/semantic-coordinator";
import type {
  SemanticCellResult,
  SemanticCompletionResult,
  SemanticDiagnostic,
  SemanticNotebookResult,
  SemanticProjectInput,
  SemanticQuickInfo,
} from "../compiler/semantic-protocol";
import { TINY_COMMERCE_NOTEBOOK } from "../demo/notebook";
import { appendChild, insertSibling, update } from "../model/commands";
import type {
  CellId,
  CellKind,
  CommandError,
  NotebookDocument,
} from "../model/types";
import type { DependencyIssue } from "../runtime/analysis-types";
import { executeNotebookTransaction } from "../runtime/execute";
import {
  createRuntimeRegistry,
  ensureCellRuntime,
  synchronizeRuntimeRegistry,
} from "../runtime/registry";
import type {
  CellRuntime,
  CellRuntimeRegistry,
} from "../runtime/registry";

interface Box<T> {
  readonly current: T;
}

export type SemanticDisplayStatus =
  | "cached"
  | "provisional"
  | "pending"
  | "authoritative"
  | "unavailable";

export interface CellSemanticDisplay {
  readonly status: SemanticDisplayStatus;
  readonly result: SemanticCellResult | undefined;
}

export interface NotebookController {
  readonly document: Accessor<NotebookDocument>;
  readonly prepared: Accessor<PreparedNotebook | undefined>;
  readonly error: Accessor<string | undefined>;
  readonly running: Accessor<boolean>;
  readonly hydrating: Accessor<boolean>;
  readonly cached: Accessor<boolean>;
  readonly preparedStale: Accessor<boolean>;
  runAll(): void;
  runCell(cellId: CellId): void;
  updateCellSource(cellId: CellId, source: string): CommandError | undefined;
  renameCell(cellId: CellId, name: string): CommandError | undefined;
  createCell(
    referenceId: CellId,
    kind: CellKind,
    placement: "after" | "child",
  ): CellId | CommandError;
  runtimeFor(cellId: CellId): CellRuntime | undefined;
  preparationFor(cellId: CellId): PreparedCell | undefined;
  semanticFor(cellId: CellId): CellSemanticDisplay;
  completionsFor(cellId: CellId, position: number): Promise<SemanticCompletionResult>;
  diagnosticsFor(cellId: CellId): Promise<readonly SemanticDiagnostic[]>;
  quickInfoFor(cellId: CellId, position: number): Promise<SemanticQuickInfo | undefined>;
}

export interface NotebookControllerOptions {
  readonly document?: NotebookDocument;
  readonly cache?: NotebookCache;
  readonly fastCoordinator?: FastPreparationCoordinator;
  readonly semanticCoordinator?: SemanticCoordinator;
}

const INITIAL_SOURCE: Record<CellKind, string> = {
  text: "",
  javascript: "$(() => {\n  \n})",
  markdown: "md(() => `\n`)",
};

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Notebook execution failed";
  }
}

function sameIssues(
  left: readonly DependencyIssue[],
  right: readonly DependencyIssue[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((issue, index) => {
        const other = right[index];
        return (
          other !== undefined &&
          issue.classification === other.classification &&
          issue.code === other.code &&
          issue.message === other.message &&
          issue.span.start === other.span.start &&
          issue.span.end === other.span.end
        );
      }))
  );
}

function sameCellIds(
  left: readonly CellId[],
  right: readonly CellId[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((cellId, index) => cellId === right[index]))
  );
}

function samePreparedCell(left: PreparedCell, right: PreparedCell): boolean {
  if (left === right) return true;
  if (
    left.cellId !== right.cellId ||
    left.kind !== right.kind ||
    left.source !== right.source ||
    left.type !== right.type ||
    left.status !== right.status ||
    !sameCellIds(left.dependencies, right.dependencies) ||
    !sameIssues(left.issues, right.issues)
  ) {
    return false;
  }
  if (left.ok && right.ok) return left.code === right.code;
  if (!left.ok && !right.ok) {
    return (
      left.error.code === right.error.code &&
      left.error.message === right.error.message
    );
  }
  return false;
}

function sameDiagnostics(
  left: readonly SemanticDiagnostic[],
  right: readonly SemanticDiagnostic[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((diagnostic, index) => {
        const other = right[index];
        return (
          other !== undefined &&
          diagnostic.from === other.from &&
          diagnostic.to === other.to &&
          diagnostic.severity === other.severity &&
          diagnostic.message === other.message
        );
      }))
  );
}

function sameSemanticResult(
  left: SemanticCellResult | undefined,
  right: SemanticCellResult | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.cellId === right.cellId &&
    left.type === right.type &&
    left.status === right.status &&
    sameDiagnostics(left.diagnostics, right.diagnostics)
  );
}

function changedTextCellsOnly(
  document: NotebookDocument,
  changedIds: readonly CellId[] | undefined,
): boolean {
  return (
    changedIds !== undefined &&
    changedIds.length > 0 &&
    changedIds.every((cellId) => document.cells[cellId]?.kind === "text")
  );
}

function disposeRegistry(registry: CellRuntimeRegistry): void {
  for (const runtime of registry.values()) runtime.dispose();
  registry.clear();
}

function expectedSemanticInterruption(error: unknown): boolean {
  return (
    error instanceof SemanticScheduleCancelledError ||
    error instanceof SemanticScheduleReplacedError ||
    error instanceof StaleSemanticRequestError
  );
}

export function createNotebookController(
  options: NotebookControllerOptions = {},
): NotebookController {
  const initialDocument = options.document ?? TINY_COMMERCE_NOTEBOOK;
  const coordinator = options.fastCoordinator ?? new FastPreparationCoordinator();
  const executionScheduler = new ExecutionPreparationScheduler((document) =>
    coordinator.prepareFast(document),
  );
  const semanticCoordinator =
    options.semanticCoordinator ?? new SemanticCoordinator();
  const semanticScheduler = new SemanticInferenceScheduler((input) =>
    semanticCoordinator.infer(input),
  );
  let cache = options.cache;
  if (!cache) {
    try {
      cache = new IndexedDbNotebookCache();
    } catch {
      cache = undefined;
    }
  }
  const registry = createRuntimeRegistry();
  for (const cell of Object.values(initialDocument.cells)) {
    ensureCellRuntime(registry, cell.id);
  }
  const [documentBox, setDocumentBox] = createSignal<Box<NotebookDocument>>({
    current: initialDocument,
  });
  const [preparedBox, setPreparedBox] = createSignal<
    Box<PreparedNotebook | undefined>
  >({ current: undefined });
  const [semanticBox, setSemanticBox] = createSignal<
    Box<SemanticNotebookResult | undefined>
  >({ current: undefined });
  const [semanticStatus, setSemanticStatus] =
    createSignal<SemanticDisplayStatus>("provisional");
  const [errorBox, setErrorBox] = createSignal<Box<string | undefined>>({
    current: undefined,
  });
  const [running, setRunning] = createSignal(false);
  const [hydrating, setHydrating] = createSignal(true);
  const [cached, setCached] = createSignal(false);
  const [preparedStale, setPreparedStale] = createSignal(false);
  const [runtimeEpoch, setRuntimeEpoch] = createSignal(0);

  let currentDocument = initialDocument;
  let currentRevision = revisionForDocument(initialDocument);
  let currentPrepared: PreparedNotebook | undefined;
  let preparedById = new Map<CellId, PreparedCell>();
  const semanticById = new Map<CellId, SemanticCellResult>();
  const semanticDisplayById = new Map<CellId, CellSemanticDisplay>();
  const hydratedCellIds = new Set<CellId>();
  let semanticChangedCellIds: readonly CellId[] | undefined;
  let semanticGeneration = 0;
  let semanticPhase: SemanticDisplayStatus = "provisional";
  let semanticRevision = currentRevision;
  let publishedSemanticRevision: string | undefined;
  let activeRun = 0;
  let queuedRun = false;
  let disposed = false;

  const adoptDocument = (document: NotebookDocument): void => {
    currentDocument = document;
    currentRevision = revisionForDocument(document);
    setDocumentBox({ current: document });
  };

  const rebuildVisiblePreparation = (): void => {
    if (!currentPrepared) {
      preparedById = new Map();
      return;
    }
    const next = new Map<CellId, PreparedCell>();
    for (const prepared of currentPrepared.cells) {
      const semantic = semanticById.get(prepared.cellId);
      const visible =
        semantic &&
        (semantic.type !== prepared.type || semantic.status !== prepared.status)
          ? { ...prepared, type: semantic.type, status: semantic.status }
          : prepared;
      const previous = preparedById.get(prepared.cellId);
      next.set(
        prepared.cellId,
        previous && samePreparedCell(previous, visible) ? previous : visible,
      );
    }
    preparedById = next;
  };

  const persist = (
    snapshot: NotebookDocument,
    prepared: PreparedNotebook,
  ): void => {
    if (!cache || disposed || prepared.revision !== revisionForDocument(snapshot)) {
      return;
    }
    const values: Array<readonly [CellId, unknown]> = [];
    for (const [cellId, runtime] of registry) {
      if (
        runtime.status() === "success" ||
        runtime.status() === "cached"
      ) {
        values.push([cellId, runtime.peek()]);
      }
    }
    void cache.save(snapshot, prepared, values).catch(() => {
      // Persistent cache availability never changes an execution outcome.
    });
  };


  const updateSemanticStatus = (status: SemanticDisplayStatus): void => {
    semanticPhase = status;
    setSemanticStatus(status);
  };

  const publishSemantic = (
    generation: number,
    revision: string,
    semantic: SemanticNotebookResult,
  ): boolean => {
    if (
      disposed ||
      generation !== semanticGeneration ||
      revision !== semanticRevision ||
      semantic.revision !== revision
    ) {
      return false;
    }
    if (
      semanticPhase === "authoritative" &&
      publishedSemanticRevision === revision
    ) {
      return true;
    }
    semanticById.clear();
    for (const cell of semantic.cells) {
      semanticById.set(cell.cellId, cell);
    }
    if (currentPrepared?.revision === revision) {
      currentPrepared = {
        ...currentPrepared,
        cells: currentPrepared.cells.map((prepared) => {
          const semanticCell = semanticById.get(prepared.cellId);
          return semanticCell &&
            (semanticCell.type !== prepared.type ||
              semanticCell.status !== prepared.status)
            ? {
                ...prepared,
                type: semanticCell.type,
                status: semanticCell.status,
              }
            : prepared;
        }),
      };
      setPreparedBox({ current: currentPrepared });
    }
    rebuildVisiblePreparation();
    setSemanticBox({ current: semantic });
    publishedSemanticRevision = revision;
    updateSemanticStatus("authoritative");
    if (currentPrepared) persist(currentDocument, currentPrepared);
    return true;
  };

  const invalidateSemantic = (
    document: NotebookDocument,
    changedCellIds?: readonly CellId[],
  ): void => {
    semanticGeneration += 1;
    semanticChangedCellIds = changedCellIds;
    semanticScheduler.cancel();
    semanticCoordinator.synchronize(document);
    semanticRevision = revisionForDocument(document);
    publishedSemanticRevision = undefined;
    if (changedCellIds && currentPrepared) {
      for (const cellId of preparedDownstreamClosure(
        currentPrepared.graph,
        changedCellIds,
      )) {
        semanticById.delete(cellId);
      }
    } else {
      semanticById.clear();
    }
    rebuildVisiblePreparation();
    setSemanticBox({ current: undefined });
    updateSemanticStatus("provisional");
  };

  const scheduleSemantic = (
    snapshot: NotebookDocument,
    prepared: PreparedNotebook,
    changedCellIds?: readonly CellId[],
  ): void => {
    const revision = prepared.revision;
    const generation = semanticGeneration;
    semanticRevision = revision;
    const input: SemanticProjectInput = {
      document: snapshot,
      prepared,
      ...(changedCellIds === undefined ? {} : { changedCellIds }),
    };
    updateSemanticStatus("pending");
    void semanticScheduler.schedule(input).then(
      (semantic) => {
        publishSemantic(generation, revision, semantic);
      },
      (error: unknown) => {
        if (
          !disposed &&
          generation === semanticGeneration &&
          revision === semanticRevision &&
          !expectedSemanticInterruption(error)
        ) {
          updateSemanticStatus("unavailable");
        }
      },
    );
  };

  const dropHydratedValues = (changedIds?: readonly CellId[]): void => {
    if (hydratedCellIds.size === 0) return;
    const invalidated =
      changedIds && currentPrepared
        ? preparedDownstreamClosure(currentPrepared.graph, changedIds)
        : undefined;
    if (!invalidated) {
      hydratedCellIds.clear();
      setCached(false);
      return;
    }
    let dropped = false;
    for (const cellId of invalidated) {
      dropped = hydratedCellIds.delete(cellId) || dropped;
    }
    if (dropped) setCached(false);
  };

  const runDocument = async (
    snapshot: NotebookDocument,
    changedIds?: readonly CellId[],
    delayed = false,
  ): Promise<void> => {
    if (!delayed) executionScheduler.cancel();
    const run = ++activeRun;
    const revision = revisionForDocument(snapshot);
    dropHydratedValues(changedIds);
    setPreparedStale(currentPrepared?.revision !== revision);
    setRunning(true);
    setErrorBox({ current: undefined });
    synchronizeRuntimeRegistry(registry, snapshot);
    setRuntimeEpoch((current) => current + 1);

    try {
      const prepared = await (delayed
        ? executionScheduler.schedule(snapshot)
        : coordinator.prepareFast(snapshot));
      if (
        disposed ||
        run !== activeRun ||
        revision !== currentRevision ||
        prepared.revision !== revision
      ) {
        return;
      }

      currentPrepared = prepared;
      rebuildVisiblePreparation();
      setPreparedBox({ current: prepared });
      setPreparedStale(false);
      executeNotebookTransaction(
        snapshot,
        registry,
        changedIds === undefined ? { prepared } : { prepared, changedIds },
      );
      setRuntimeEpoch((current) => current + 1);
      persist(snapshot, prepared);
      if (!changedTextCellsOnly(snapshot, changedIds)) {
        scheduleSemantic(snapshot, prepared, changedIds);
      }
    } catch (error) {
      if (!disposed && run === activeRun) {
        setErrorBox({ current: errorMessage(error) });
      }
    } finally {
      if (!disposed && run === activeRun) setRunning(false);
    }
  };

  const semanticInput = async (): Promise<{
    readonly revision: string;
    readonly input: SemanticProjectInput;
  }> => {
    const snapshot = currentDocument;
    const revision = currentRevision;
    const prepared =
      currentPrepared?.revision === revision
        ? currentPrepared
        : await coordinator.prepareFast(snapshot);
    if (
      disposed ||
      revision !== currentRevision ||
      prepared.revision !== revision
    ) {
      throw new StaleSemanticRequestError();
    }
    semanticRevision = revision;
    return {
      revision,
      input: {
        document: snapshot,
        prepared,
        ...(semanticChangedCellIds === undefined
          ? {}
          : { changedCellIds: semanticChangedCellIds }),
      },
    };
  };

  const demandedSemantic = async <T>(
    demand: (input: SemanticProjectInput) => Promise<T>,
  ): Promise<T> => {
    const revisionAtDemand = currentRevision;
    const alreadyAuthoritative =
      semanticPhase === "authoritative" &&
      publishedSemanticRevision === revisionAtDemand;
    semanticGeneration += 1;
    const generation = semanticGeneration;
    semanticScheduler.cancel();
    if (!alreadyAuthoritative) updateSemanticStatus("pending");
    try {
      const { revision, input } = await semanticInput();
      const value = await demand(input);
      const semantic = semanticCoordinator.current();
      if (semantic) publishSemantic(generation, revision, semantic);
      return value;
    } catch (error) {
      if (
        !disposed &&
        !alreadyAuthoritative &&
        generation === semanticGeneration &&
        !expectedSemanticInterruption(error) &&
        semanticCoordinator.state().currentRevision === semanticRevision
      ) {
        updateSemanticStatus("unavailable");
      }
      throw error;
    }
  };

  const hydrate = async (snapshot: NotebookDocument): Promise<void> => {
    const revision = currentRevision;
    synchronizeRuntimeRegistry(registry, snapshot);
    setRuntimeEpoch((current) => current + 1);
    let hydrated = false;
    try {
      const record = await cache?.load(snapshot);
      if (!record || disposed || revision !== currentRevision) {
        return;
      }
      const prepared = coordinator.seed(snapshot, record.prepared);
      currentPrepared = prepared;
      semanticById.clear();
      rebuildVisiblePreparation();
      setPreparedBox({ current: prepared });
      setSemanticBox({ current: undefined });
      publishedSemanticRevision = undefined;
      updateSemanticStatus("cached");
      for (const [cellId, value] of Object.entries(record.values)) {
        ensureCellRuntime(registry, cellId).hydrateCached(value);
        hydratedCellIds.add(cellId);
      }
      setRuntimeEpoch((current) => current + 1);
      setCached(true);
      hydrated = true;
      scheduleSemantic(snapshot, prepared);
    } catch {
      // IndexedDB and malformed records degrade to the normal execution path.
    } finally {
      if (!disposed) {
        setHydrating(false);
        if (queuedRun) {
          queuedRun = false;
          invalidateSemantic(currentDocument);
          void runDocument(currentDocument);
        } else if (!hydrated && revision === currentRevision) {
          void runDocument(snapshot);
        }
      }
    }
  };

  onSettled(() => {
    void hydrate(currentDocument);
    return () => {
      disposed = true;
      activeRun += 1;
      executionScheduler.cancel();
      semanticScheduler.cancel();
      cache?.dispose();
      coordinator.dispose();
      semanticCoordinator.dispose();
      disposeRegistry(registry);
    };
  });

  return {
    document: () => documentBox().current,
    prepared: () => preparedBox().current,
    error: () => errorBox().current,
    running,
    hydrating,
    cached,
    preparedStale,
    runAll() {
      if (hydrating()) {
        queuedRun = true;
        return;
      }
      invalidateSemantic(currentDocument);
      void runDocument(currentDocument);
    },
    runCell(cellId) {
      if (hydrating()) {
        queuedRun = true;
        return;
      }
      void runDocument(currentDocument, [cellId]);
    },
    updateCellSource(cellId, source) {
      const currentCell = currentDocument.cells[cellId];
      if (currentCell?.source === source) return undefined;

      const result = update(currentDocument, cellId, { source });
      if (!result.ok) return result.error;

      adoptDocument(result.document);
      if (currentCell?.kind !== "text") {
        invalidateSemantic(result.document, [cellId]);
      }
      void runDocument(result.document, [cellId], true);
      return undefined;
    },
    renameCell(cellId, name) {
      const currentCell = currentDocument.cells[cellId];
      if (currentCell?.name === name) return undefined;

      const result = update(currentDocument, cellId, { name });
      if (!result.ok) return result.error;

      adoptDocument(result.document);
      invalidateSemantic(result.document, [cellId]);
      void runDocument(result.document);
      return undefined;
    },
    createCell(referenceId, kind, placement) {
      const input = {
        id: `cell-${crypto.randomUUID()}`,
        kind,
        source: INITIAL_SOURCE[kind],
        classes: [],
        metadata: {},
      };
      const result =
        placement === "child"
          ? appendChild(currentDocument, referenceId, input)
          : insertSibling(currentDocument, referenceId, "after", input);
      if (!result.ok) return result.error;

      adoptDocument(result.document);
      invalidateSemantic(result.document, [input.id]);
      void runDocument(result.document, [input.id]);
      return input.id;
    },
    runtimeFor(cellId) {
      runtimeEpoch();
      return registry.get(cellId);
    },
    preparationFor(cellId) {
      preparedBox();
      semanticBox();
      return preparedById.get(cellId);
    },
    semanticFor(cellId) {
      semanticBox();
      const phase = semanticStatus();
      const result = semanticById.get(cellId);
      const previous = semanticDisplayById.get(cellId);
      const status = result === undefined ? phase : "authoritative";
      const stable =
        previous && sameSemanticResult(previous.result, result)
          ? previous.result
          : result;
      if (previous && previous.status === status && previous.result === stable) {
        return previous;
      }
      const display: CellSemanticDisplay = { status, result: stable };
      semanticDisplayById.set(cellId, display);
      return display;
    },
    completionsFor(cellId, position) {
      return demandedSemantic((input) =>
        semanticCoordinator.completions(input, cellId, position),
      );
    },
    diagnosticsFor(cellId) {
      return demandedSemantic((input) =>
        semanticCoordinator.diagnostics(input, cellId),
      );
    },
    quickInfoFor(cellId, position) {
      return demandedSemantic((input) =>
        semanticCoordinator.quickInfo(input, cellId, position),
      );
    },
  };
}
