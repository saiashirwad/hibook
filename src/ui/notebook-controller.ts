import { createSignal, onSettled } from "solid-js";
import type { Accessor } from "solid-js";
import {
  ExecutionPreparationScheduler,
  FastPreparationCoordinator,
} from "../compiler/coordinator";
import type { PreparedCell, PreparedNotebook } from "../compiler/protocol";
import { revisionForDocument } from "../compiler/protocol";
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

export function createNotebookController(): NotebookController {
  const coordinator = new FastPreparationCoordinator();
  const executionScheduler = new ExecutionPreparationScheduler((document) =>
    coordinator.prepareFast(document),
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
  const [errorBox, setErrorBox] = createSignal<Box<string | undefined>>({
    current: undefined,
  });
  const [running, setRunning] = createSignal(false);
  const [runtimeEpoch, setRuntimeEpoch] = createSignal(0);

  let currentDocument = TINY_COMMERCE_NOTEBOOK;
  let currentPrepared: PreparedNotebook | undefined;
  let preparedById = new Map<CellId, PreparedCell>();
  let activeRun = 0;
  let disposed = false;

  const runDocument = async (
    snapshot: NotebookDocument,
    changedIds?: readonly CellId[],
    delayed = false,
  ): Promise<void> => {
    if (!delayed) executionScheduler.cancel();
    const run = ++activeRun;
    const revision = revisionForDocument(snapshot);
    if (currentPrepared?.revision !== revision) {
      setPreparedBox({ current: undefined });
      preparedById = new Map<CellId, PreparedCell>();
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
      preparedById = new Map(
        prepared.cells.map((cell) => [cell.cellId, cell] as const),
      );
      setPreparedBox({ current: prepared });
      executeNotebookTransaction(
        snapshot,
        registry,
        changedIds === undefined ? { prepared } : { prepared, changedIds },
      );
      setRuntimeEpoch((current) => current + 1);
    } catch (error) {
      if (!disposed && run === activeRun) {
        setErrorBox({ current: errorMessage(error) });
      }
    } finally {
      if (!disposed && run === activeRun) setRunning(false);
    }
  };

  onSettled(() => {
    void runDocument(currentDocument);
    return () => {
      disposed = true;
      activeRun += 1;
      executionScheduler.cancel();
      coordinator.dispose();
      disposeRegistry(registry);
    };
  });

  return {
    document: () => documentBox().current,
    prepared: () => preparedBox().current,
    error: () => errorBox().current,
    running,
    runAll() {
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
      return preparedById.get(cellId);
    },
  };
}
