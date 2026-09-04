import { createSignal, onSettled } from "solid-js";
import type { Accessor } from "solid-js";
import {
  ExecutionPreparationScheduler,
  FastPreparationCoordinator,
} from "../compiler/coordinator";
import type { PreparedCell, PreparedNotebook } from "../compiler/protocol";
import { revisionForDocument } from "../compiler/protocol";
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
import { update } from "../model/commands";
import type {
  CellId,
  CommandError,
  NotebookDocument,
} from "../model/types";
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
  runAll(): void;
  runCell(cellId: CellId): void;
  updateCellSource(cellId: CellId, source: string): CommandError | undefined;
  renameCell(cellId: CellId, name: string): CommandError | undefined;
  runtimeFor(cellId: CellId): CellRuntime | undefined;
  preparationFor(cellId: CellId): PreparedCell | undefined;
  semanticFor(cellId: CellId): CellSemanticDisplay;
  completionsFor(cellId: CellId, position: number): Promise<SemanticCompletionResult>;
  diagnosticsFor(cellId: CellId): Promise<readonly SemanticDiagnostic[]>;
  quickInfoFor(cellId: CellId, position: number): Promise<SemanticQuickInfo | undefined>;
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Notebook execution failed";
  }
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

export function createNotebookController(): NotebookController {
  const coordinator = new FastPreparationCoordinator();
  const executionScheduler = new ExecutionPreparationScheduler((document) =>
    coordinator.prepareFast(document),
  );
  const semanticCoordinator = new SemanticCoordinator();
  const semanticScheduler = new SemanticInferenceScheduler((input) =>
    semanticCoordinator.infer(input),
  );
  const registry = createRuntimeRegistry();
  for (const cell of Object.values(TINY_COMMERCE_NOTEBOOK.cells)) {
    ensureCellRuntime(registry, cell.id);
  }
  const [documentBox, setDocumentBox] = createSignal<Box<NotebookDocument>>({
    current: TINY_COMMERCE_NOTEBOOK,
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
  const [runtimeEpoch, setRuntimeEpoch] = createSignal(0);

  let currentDocument = TINY_COMMERCE_NOTEBOOK;
  let currentPrepared: PreparedNotebook | undefined;
  let preparedById = new Map<CellId, PreparedCell>();
  let semanticById = new Map<CellId, SemanticCellResult>();
  let semanticChangedCellIds: readonly CellId[] | undefined;
  let semanticGeneration = 0;
  let semanticPhase: SemanticDisplayStatus = "provisional";
  let publishedSemanticRevision: string | undefined;
  let activeRun = 0;
  let disposed = false;

  const rebuildVisiblePreparation = (): void => {
    if (!currentPrepared) {
      preparedById = new Map();
      return;
    }
    preparedById = new Map(
      currentPrepared.cells.map((prepared) => {
        const semantic = semanticById.get(prepared.cellId);
        return [
          prepared.cellId,
          semantic
            ? { ...prepared, type: semantic.type, status: semantic.status }
            : prepared,
        ] as const;
      }),
    );
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
      revision !== revisionForDocument(currentDocument) ||
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
    semanticById = new Map(
      semantic.cells.map((cell) => [cell.cellId, cell] as const),
    );
    rebuildVisiblePreparation();
    setSemanticBox({ current: semantic });
    publishedSemanticRevision = revision;
    updateSemanticStatus("authoritative");
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
    publishedSemanticRevision = undefined;
    semanticById = new Map();
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
          revision === revisionForDocument(currentDocument) &&
          !expectedSemanticInterruption(error)
        ) {
          updateSemanticStatus("unavailable");
        }
      },
    );
  };

  const runDocument = async (
    snapshot: NotebookDocument,
    changedIds?: readonly CellId[],
    delayed = false,
  ): Promise<void> => {
    if (!delayed) executionScheduler.cancel();
    const run = ++activeRun;
    const revision = revisionForDocument(snapshot);
    if (currentPrepared?.revision !== revision) {
      currentPrepared = undefined;
      setPreparedBox({ current: undefined });
      rebuildVisiblePreparation();
    }
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
        revision !== revisionForDocument(currentDocument) ||
        prepared.revision !== revision
      ) {
        return;
      }

      currentPrepared = prepared;
      rebuildVisiblePreparation();
      setPreparedBox({ current: prepared });
      executeNotebookTransaction(
        snapshot,
        registry,
        changedIds === undefined ? { prepared } : { prepared, changedIds },
      );
      setRuntimeEpoch((current) => current + 1);
      scheduleSemantic(snapshot, prepared, changedIds);
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
    const revision = revisionForDocument(snapshot);
    const prepared =
      currentPrepared?.revision === revision
        ? currentPrepared
        : await coordinator.prepareFast(snapshot);
    if (
      disposed ||
      revision !== revisionForDocument(currentDocument) ||
      prepared.revision !== revision
    ) {
      throw new StaleSemanticRequestError();
    }
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
    const revisionAtDemand = revisionForDocument(currentDocument);
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
        semanticCoordinator.state().currentRevision ===
          revisionForDocument(currentDocument)
      ) {
        updateSemanticStatus("unavailable");
      }
      throw error;
    }
  };

  onSettled(() => {
    void runDocument(currentDocument);
    return () => {
      disposed = true;
      activeRun += 1;
      executionScheduler.cancel();
      semanticScheduler.cancel();
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
    runAll() {
      invalidateSemantic(currentDocument);
      void runDocument(currentDocument);
    },
    runCell(cellId) {
      void runDocument(currentDocument, [cellId]);
    },
    updateCellSource(cellId, source) {
      const currentCell = currentDocument.cells[cellId];
      if (currentCell?.source === source) return undefined;

      const result = update(currentDocument, cellId, { source });
      if (!result.ok) return result.error;

      currentDocument = result.document;
      invalidateSemantic(result.document, [cellId]);
      setDocumentBox({ current: result.document });
      void runDocument(result.document, [cellId], true);
      return undefined;
    },
    renameCell(cellId, name) {
      const currentCell = currentDocument.cells[cellId];
      if (currentCell?.name === name) return undefined;

      const result = update(currentDocument, cellId, { name });
      if (!result.ok) return result.error;

      currentDocument = result.document;
      invalidateSemantic(result.document);
      setDocumentBox({ current: result.document });
      void runDocument(result.document);
      return undefined;
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
      return {
        status: semanticStatus(),
        result: semanticById.get(cellId),
      };
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
