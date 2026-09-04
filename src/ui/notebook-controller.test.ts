import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import type { NotebookCache } from "../cache/indexeddb";
import { FastPreparationCoordinator } from "../compiler/coordinator";
import { FastPreparationCore } from "../compiler/fast-prepare";
import type { FastWorkerLike } from "../compiler/coordinator";
import { SemanticCoordinator } from "../compiler/semantic-coordinator";
import type { SemanticWorkerLike } from "../compiler/semantic-coordinator";
import type { SemanticNotebookResult } from "../compiler/semantic-protocol";
import type { Cell, CellKind, NotebookDocument } from "../model/types";
import { createNotebookController } from "./notebook-controller";
import type { NotebookController } from "./notebook-controller";

const EXECUTION_SETTLE_MS = 200;
const SEMANTIC_SETTLE_MS = 500;

function cell(
  id: string,
  kind: CellKind,
  source: string,
  children: string[] = [],
): Cell {
  return { id, name: id, kind, source, classes: [], metadata: {}, children };
}

function testDocument(): NotebookDocument {
  const cells = [
    cell("root", "text", "Notebook", ["intro", "base", "derived", "other"]),
    cell("intro", "text", "Prose"),
    cell("base", "javascript", "$(() => 1)"),
    cell("derived", "javascript", "$(({ root }) => root.base.value + 1)"),
    cell("other", "javascript", "$(() => 2)"),
  ];
  return {
    rootId: "root",
    cells: Object.fromEntries(cells.map((entry) => [entry.id, entry])),
  };
}

const inertCache: NotebookCache = {
  load: () => Promise.resolve(undefined),
  save: () => Promise.reject(new Error("Cache writes are disabled in tests")),
  dispose: () => undefined,
};

function fastCoordinator(): FastPreparationCoordinator {
  return new FastPreparationCoordinator(() => {
    const core = new FastPreparationCore();
    const worker: FastWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(request) {
        const prepared = core.prepare(request.document, request.revision);
        queueMicrotask(() => {
          worker.onmessage?.({
            data: {
              type: "prepared",
              requestId: request.requestId,
              revision: request.revision,
              prepared,
            },
          });
        });
      },
      terminate: () => undefined,
    };
    return worker;
  });
}

function semanticCoordinator(inferences: { count: number }): SemanticCoordinator {
  return new SemanticCoordinator(() => {
    const worker: SemanticWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(request) {
        if (request.type !== "infer") return;
        inferences.count += 1;
        const semantic: SemanticNotebookResult = {
          revision: request.revision,
          cells: request.prepared.cells.map((prepared) => ({
            cellId: prepared.cellId,
            authoritative: true,
            type: prepared.kind === "text" ? "string" : "number",
            status: prepared.kind === "text" ? "text" : "inferred",
            diagnostics: [],
          })),
          timings: {
            workerStartupMs: 0,
            projectSyncMs: 0,
            inferenceMs: 0,
            totalMs: 0,
            counters: {
              vfsWrites: 0,
              vfsSkips: 0,
              layers: 1,
              programBuilds: 1,
              reusedCells: 0,
            },
          },
        };
        queueMicrotask(() => {
          worker.onmessage?.({
            data: {
              type: "inferred",
              requestId: request.requestId,
              revision: request.revision,
              semantic,
            },
          });
        });
      },
      terminate: () => undefined,
    };
    return worker;
  });
}

function settle(delayMs = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withController(
  run: (
    controller: NotebookController,
    inferences: { count: number },
  ) => Promise<void>,
): Promise<void> {
  const inferences = { count: 0 };
  let dispose!: () => void;
  const controller = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createNotebookController({
      document: testDocument(),
      cache: inertCache,
      fastCoordinator: fastCoordinator(),
      semanticCoordinator: semanticCoordinator(inferences),
    });
  });
  try {
    // Cache hydration only starts under a rendered root, so an edit drives the
    // first preparation and inference instead.
    controller.updateCellSource("base", "$(() => 10)");
    await settle(SEMANTIC_SETTLE_MS);
    expect(controller.semanticFor("derived").status).toBe("authoritative");
    await run(controller, inferences);
  } finally {
    dispose();
  }
}

describe("notebook controller", () => {
  it("leaves semantic results untouched while prose cells are edited", async () => {
    await withController(async (controller, inferences) => {
      const inferencesBeforeEdit = inferences.count;
      const semantic = controller.semanticFor("derived");
      const preparation = controller.preparationFor("derived");

      controller.updateCellSource("intro", "Prose edit");
      expect(controller.semanticFor("derived")).toBe(semantic);
      expect(controller.preparationFor("derived")).toBe(preparation);

      await settle(SEMANTIC_SETTLE_MS);
      expect(controller.document().cells.intro?.source).toBe("Prose edit");
      expect(controller.semanticFor("derived")).toBe(semantic);
      expect(controller.preparationFor("derived")).toBe(preparation);
      expect(inferences.count).toBe(inferencesBeforeEdit);
    });
  });

  it("invalidates only the edited cell and its dependents", async () => {
    await withController(async (controller) => {
      const derived = controller.semanticFor("derived");
      const other = controller.semanticFor("other");

      controller.updateCellSource("base", "$(() => 3)");
      expect(controller.semanticFor("other")).toBe(other);
      expect(controller.semanticFor("derived")).not.toBe(derived);
      expect(controller.semanticFor("derived").result).toBeUndefined();

      await settle(SEMANTIC_SETTLE_MS);
      expect(controller.semanticFor("other")).toBe(other);
      expect(controller.semanticFor("derived").status).toBe("authoritative");
    });
  });

  it("keeps the last prepared notebook visible while an edit is preparing", async () => {
    await withController(async (controller) => {
      const preparation = controller.preparationFor("derived");

      controller.updateCellSource("base", "$(() => 4)");
      expect(controller.prepared()).toBeDefined();
      expect(controller.preparedStale()).toBe(true);
      expect(controller.preparationFor("derived")).toBe(preparation);

      await settle(EXECUTION_SETTLE_MS);
      expect(controller.preparedStale()).toBe(false);
      expect(controller.preparationFor("other")?.type).toBe("number");
    });
  });
});
