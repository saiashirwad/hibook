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
const SEMANTIC_SETTLE_MS = 750;

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
  it("keeps imported code paused through edits and undo/redo", async () => {
    let dispose!: () => void;
    const saved: Array<{ source: string; enabled: boolean }> = [];
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createNotebookController({
        document: testDocument(),
        executionEnabled: false,
        cache: inertCache,
        fastCoordinator: fastCoordinator(),
        semanticCoordinator: semanticCoordinator({ count: 0 }),
        onDocumentChange(document, enabled) {
          saved.push({ source: document.cells.base?.source ?? "", enabled });
        },
      });
    });
    try {
      controller.updateCellSource("base", "$(() => 7)");
      await settle(EXECUTION_SETTLE_MS);
      expect(controller.runtimeFor("base")?.status()).toBe("idle");
      expect(saved.at(-1)).toEqual({ source: "$(() => 7)", enabled: false });
      controller.undo();
      expect(controller.document().cells.base?.source).toBe("$(() => 1)");
      controller.redo();
      expect(controller.document().cells.base?.source).toBe("$(() => 7)");
      expect(controller.executionEnabled()).toBe(false);
      expect(controller.runtimeFor("base")?.status()).toBe("idle");
    } finally {
      dispose();
    }
  });

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

  it("splits a root note into a following child and keeps later paragraphs", () => {
    let dispose!: () => void;
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createNotebookController({
        document: {
          rootId: "root",
          cells: {
            root: cell("root", "text", "Kyoto.\n\nStay, 18000 yen.\n\nThen a number.", ["base"]),
            base: cell("base", "javascript", "$(() => 1)"),
          },
        },
        executionEnabled: false,
        cache: inertCache,
        fastCoordinator: fastCoordinator(),
        semanticCoordinator: semanticCoordinator({ count: 0 }),
      });
    });
    try {
      const created = controller.splitCell("root", "Kyoto.\n\n".length);
      expect(typeof created).toBe("string");
      const nextId = created as string;
      expect(controller.document().cells.root?.source).toBe("Kyoto.");
      expect(controller.document().cells.root?.children[0]).toBe(nextId);
      expect(controller.document().cells.root?.children).toContain("base");
      expect(controller.document().cells[nextId]?.source).toBe("Stay, 18000 yen.\n\nThen a number.");
      expect(controller.document().cells[nextId]?.kind).toBe("text");
    } finally {
      dispose();
    }
  });

  it("indents a note under the previous sibling and outdents it again", () => {
    let dispose!: () => void;
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createNotebookController({
        document: testDocument(),
        executionEnabled: false,
        cache: inertCache,
        fastCoordinator: fastCoordinator(),
        semanticCoordinator: semanticCoordinator({ count: 0 }),
      });
    });
    try {
      expect(controller.indentCell("base")).toBeUndefined();
      expect(controller.document().cells.intro?.children).toEqual(["base"]);
      expect(controller.document().cells.root?.children).toEqual(["intro", "derived", "other"]);
      expect(controller.outdentCell("base")).toBeUndefined();
      expect(controller.document().cells.intro?.children).toEqual([]);
      expect(controller.document().cells.root?.children).toEqual(["intro", "base", "derived", "other"]);
      expect(controller.indentCell("root")?.code).toBe("ROOT_PROTECTED");
      expect(controller.outdentCell("intro")?.code).toBe("ROOT_HAS_NO_SIBLINGS");
    } finally {
      dispose();
    }
  });

  it("deletes a note and its nested children, and undo restores them", () => {
    let dispose!: () => void;
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createNotebookController({
        document: testDocument(),
        executionEnabled: false,
        cache: inertCache,
        fastCoordinator: fastCoordinator(),
        semanticCoordinator: semanticCoordinator({ count: 0 }),
      });
    });
    try {
      expect(controller.indentCell("base")).toBeUndefined();
      const focusId = controller.deleteCell("intro");
      expect(focusId).toBe("root");
      expect(controller.document().cells.intro).toBeUndefined();
      expect(controller.document().cells.base).toBeUndefined();
      expect(controller.document().cells.root?.children).toEqual(["derived", "other"]);
      expect(controller.deleteCell("root")).toMatchObject({ code: "ROOT_PROTECTED" });
      controller.undo();
      expect(controller.document().cells.intro?.children).toEqual(["base"]);
      expect(controller.document().cells.root?.children).toEqual(["intro", "derived", "other"]);
    } finally {
      dispose();
    }
  });

  it("turns a note into a quoted calculation without dropping the prose", () => {
    let dispose!: () => void;
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createNotebookController({
        document: testDocument(),
        executionEnabled: false,
        cache: inertCache,
        fastCoordinator: fastCoordinator(),
        semanticCoordinator: semanticCoordinator({ count: 0 }),
      });
    });
    try {
      expect(controller.convertCell("intro", "javascript")).toBeUndefined();
      expect(controller.document().cells.intro).toMatchObject({
        kind: "javascript",
        source: '$(() => "Prose")',
      });
      expect(controller.convertCell("root", "javascript")?.code).toBe("ROOT_PROTECTED");
      expect(controller.document().cells.root?.kind).toBe("text");
    } finally {
      dispose();
    }
  });

  it("carries the note into a new calculation instead of starting at zero", () => {
    let dispose!: () => void;
    const controller = createRoot((disposeRoot) => {
      dispose = disposeRoot;
      return createNotebookController({
        document: testDocument(),
        executionEnabled: false,
        cache: inertCache,
        fastCoordinator: fastCoordinator(),
        semanticCoordinator: semanticCoordinator({ count: 0 }),
      });
    });
    try {
      const created = controller.createCell("intro", "markdown", "child");
      expect(typeof created).toBe("string");
      expect(controller.document().cells[created as string]?.source).toBe('md(() => "Prose")');
      const fromRoot = controller.createCell("root", "javascript", "child");
      expect(controller.document().cells[fromRoot as string]?.source).toBe('$(() => "Notebook")');
      expect(controller.document().cells.intro?.children).toEqual([created]);
      expect(controller.document().cells.intro?.source).toBe("Prose");
      controller.updateCellSource("intro", "First paragraph.\n\nSecond paragraph.");
      const untouched = controller.createCell("intro", "javascript", "child");
      expect(controller.document().cells[untouched as string]?.source).toBe("$(() => 0)");
      expect(controller.document().cells.intro?.source).toContain("First paragraph.");
    } finally {
      dispose();
    }
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
