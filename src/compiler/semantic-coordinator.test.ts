import { describe, expect, it, vi } from "vitest";
import type { Cell, NotebookDocument } from "../model/types";
import { FastPreparationCoordinator } from "./coordinator";
import type { FastWorkerLike } from "./coordinator";
import { prepareExecution } from "./fast-prepare";
import type {
  FastPrepareRequest,
  FastPrepareResponse,
} from "./protocol";
import {
  SEMANTIC_DELAY_MS,
  SEMANTIC_COMPLETED_REVISION_LIMIT,
  SemanticCoordinator,
  SemanticCoordinatorDisposedError,
  SemanticInferenceScheduler,
  StaleSemanticRequestError,
} from "./semantic-coordinator";
import type {
  SemanticTimerDriver,
  SemanticWorkerLike,
} from "./semantic-coordinator";
import type {
  SemanticCompletionResult,
  SemanticNotebookResult,
  SemanticProjectInput,
  SemanticRequest,
  SemanticResponse,
} from "./semantic-protocol";

function notebook(source: string): NotebookDocument {
  const root: Cell = {
    id: "root",
    name: "root",
    kind: "text",
    source: "Notebook",
    classes: [],
    metadata: {},
    children: ["code"],
  };
  const code: Cell = {
    id: "code",
    name: "code",
    kind: "javascript",
    source,
    classes: [],
    metadata: {},
    children: [],
  };
  return { rootId: "root", cells: { root, code } };
}

function projectInput(document: NotebookDocument): SemanticProjectInput {
  return { document, prepared: prepareExecution(document) };
}

function semanticResult(request: SemanticRequest): SemanticNotebookResult {
  return {
    revision: request.revision,
    cells: [],
    timings: {
      workerStartupMs: 0,
      projectSyncMs: 0,
      inferenceMs: 0,
      totalMs: 0,
      counters: {
        vfsWrites: 0,
        vfsSkips: 0,
        layers: 0,
        programBuilds: 0,
        reusedCells: 0,
      },
    },
  };
}

class ControlledSemanticWorker implements SemanticWorkerLike {
  onmessage: ((event: { readonly data: SemanticResponse }) => void) | null = null;
  onerror: ((event: { readonly message?: string }) => void) | null = null;
  readonly requests: SemanticRequest[] = [];
  terminated = false;

  postMessage(message: SemanticRequest): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(request: SemanticRequest): void {
    const semantic = semanticResult(request);
    switch (request.type) {
      case "infer":
        this.onmessage?.({
          data: {
            type: "inferred",
            requestId: request.requestId,
            revision: request.revision,
            semantic,
          },
        });
        break;
      case "completions":
        this.onmessage?.({
          data: {
            type: "completions",
            requestId: request.requestId,
            revision: request.revision,
            semantic,
            completion: {
              from: request.position,
              to: request.position,
              items: [
                {
                  label: "value",
                  kind: "property",
                  detail: "readonly value: number",
                  applyText: "value",
                },
              ],
            },
          },
        });
        break;
      case "diagnostics":
        this.onmessage?.({
          data: {
            type: "diagnostics",
            requestId: request.requestId,
            revision: request.revision,
            semantic,
            diagnostics: [
              { from: 3, to: 8, severity: "error", message: "Broken value" },
            ],
          },
        });
        break;
      case "quickInfo":
        this.onmessage?.({
          data: {
            type: "quickInfo",
            requestId: request.requestId,
            revision: request.revision,
            semantic,
            quickInfo: { from: 4, to: 9, text: "property value: number" },
          },
        });
        break;
    }
  }
}

class ControlledFastWorker implements FastWorkerLike {
  onmessage: ((event: { readonly data: FastPrepareResponse }) => void) | null = null;
  onerror: ((event: { readonly message?: string }) => void) | null = null;
  readonly requests: FastPrepareRequest[] = [];

  postMessage(message: FastPrepareRequest): void {
    this.requests.push(message);
  }

  terminate(): void {}

  respond(request: FastPrepareRequest): void {
    this.onmessage?.({
      data: {
        type: "prepared",
        requestId: request.requestId,
        revision: request.revision,
        prepared: prepareExecution(request.document),
      },
    });
  }
}

class ManualTimers implements SemanticTimerDriver {
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  #nextHandle = 1;

  set(callback: () => void, delayMs: number): unknown {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.callbacks.set(handle, callback);
    this.delays.push(delayMs);
    return handle;
  }

  clear(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  run(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

describe("semantic coordinator", () => {
  it("stays unconstructed on synchronization and coalesces identical inference", async () => {
    const worker = new ControlledSemanticWorker();
    let constructions = 0;
    const coordinator = new SemanticCoordinator(() => {
      constructions += 1;
      return worker;
    });
    const input = projectInput(notebook("$(() => 1)"));

    coordinator.synchronize(input.document);
    expect(constructions).toBe(0);
    expect(coordinator.state()).toMatchObject({
      workerConstructed: false,
      workerConstructionCount: 0,
    });

    const first = coordinator.infer(input);
    const second = coordinator.infer(input);
    expect(first).toBe(second);
    expect(worker.requests).toHaveLength(1);
    worker.respond(worker.requests[0]!);
    await expect(first).resolves.toBe(coordinator.current());
    expect(coordinator.state()).toMatchObject({
      workerConstructed: true,
      workerConstructionCount: 1,
      pendingCount: 0,
    });
  });

  it("retains only the eight most recently completed revisions", async () => {
    const worker = new ControlledSemanticWorker();
    const coordinator = new SemanticCoordinator(() => worker);
    const inputs = Array.from(
      { length: SEMANTIC_COMPLETED_REVISION_LIMIT + 1 },
      (_, index) => projectInput(notebook(`$(() => ${index})`)),
    );

    for (const input of inputs) {
      const pending = coordinator.infer(input);
      worker.respond(worker.requests.at(-1)!);
      await pending;
    }
    const completedRequestCount = worker.requests.length;
    const newest = coordinator.infer(inputs.at(-1)!);
    expect(worker.requests).toHaveLength(completedRequestCount);
    await newest;

    const evicted = coordinator.infer(inputs[0]!);
    expect(worker.requests).toHaveLength(completedRequestCount + 1);
    worker.respond(worker.requests.at(-1)!);
    await evicted;
    expect(coordinator.state().workerConstructionCount).toBe(1);
  });

  it("demand-starts each tooling operation without a prior inference request", async () => {
    const worker = new ControlledSemanticWorker();
    const coordinator = new SemanticCoordinator(() => worker);
    const input = projectInput(notebook("$(({ root }) => root.value)"));

    const completionPromise = coordinator.completions(input, "code", 12);
    expect(worker.requests.map((request) => request.type)).toEqual(["completions"]);
    worker.respond(worker.requests[0]!);
    const completion: SemanticCompletionResult = await completionPromise;
    expect(completion).toEqual({
      from: 12,
      to: 12,
      items: [
        {
          label: "value",
          kind: "property",
          detail: "readonly value: number",
          applyText: "value",
        },
      ],
    });

    const diagnosticsPromise = coordinator.diagnostics(input, "code");
    worker.respond(worker.requests[1]!);
    await expect(diagnosticsPromise).resolves.toEqual([
      { from: 3, to: 8, severity: "error", message: "Broken value" },
    ]);

    const quickInfoPromise = coordinator.quickInfo(input, "code", 7);
    worker.respond(worker.requests[2]!);
    await expect(quickInfoPromise).resolves.toEqual({
      from: 4,
      to: 9,
      text: "property value: number",
    });
    expect(worker.requests.map((request) => request.type)).toEqual([
      "completions",
      "diagnostics",
      "quickInfo",
    ]);
  });

  it("rejects stale work and ignores its late response", async () => {
    const worker = new ControlledSemanticWorker();
    const coordinator = new SemanticCoordinator(() => worker);
    const oldInput = projectInput(notebook("$(() => 1)"));
    const stale = coordinator.infer(oldInput);
    const staleRequest = worker.requests[0]!;

    coordinator.synchronize(notebook("$(() => 2)"));
    await expect(stale).rejects.toBeInstanceOf(StaleSemanticRequestError);
    worker.respond(staleRequest);
    expect(coordinator.current()).toBeUndefined();
    expect(coordinator.state().pendingCount).toBe(0);
  });

  it("terminates its independent worker and rejects pending work on dispose", async () => {
    const worker = new ControlledSemanticWorker();
    const coordinator = new SemanticCoordinator(() => worker);
    const pending = coordinator.infer(projectInput(notebook("$(() => 1)")));

    coordinator.dispose();
    await expect(pending).rejects.toBeInstanceOf(SemanticCoordinatorDisposedError);
    expect(worker.terminated).toBe(true);
    await expect(
      coordinator.infer(projectInput(notebook("$(() => 2)"))),
    ).rejects.toBeInstanceOf(SemanticCoordinatorDisposedError);
  });

  it("keeps fast and semantic worker construction independent", async () => {
    const fastWorker = new ControlledFastWorker();
    const semanticWorker = new ControlledSemanticWorker();
    const fast = new FastPreparationCoordinator(() => fastWorker);
    const semantic = new SemanticCoordinator(() => semanticWorker);
    const document = notebook("$(() => 1)");

    const fastPromise = fast.prepareFast(document);
    expect(fastWorker.requests).toHaveLength(1);
    expect(semantic.state().workerConstructed).toBe(false);
    fastWorker.respond(fastWorker.requests[0]!);
    await fastPromise;

    const semanticPromise = semantic.infer(projectInput(document));
    expect(semanticWorker.requests).toHaveLength(1);
    expect(fast.state().workerConstructionCount).toBe(1);
    expect(semantic.state().workerConstructionCount).toBe(1);
    semanticWorker.respond(semanticWorker.requests[0]!);
    await semanticPromise;
  });
});

describe("semantic inference scheduler", () => {
  it("uses the semantic delay and replaces pending inference deterministically", async () => {
    const timers = new ManualTimers();
    const infer = vi.fn((input: SemanticProjectInput) =>
      Promise.resolve({
        ...semanticResult({
          type: "infer",
          requestId: "scheduled",
          revision: input.prepared.revision,
          ...input,
        }),
      }),
    );
    const scheduler = new SemanticInferenceScheduler(
      infer,
      SEMANTIC_DELAY_MS,
      timers,
    );
    const first = scheduler.schedule(projectInput(notebook("$(() => 1)"))).catch(
      (error: unknown) => error,
    );
    const latestInput = projectInput(notebook("$(() => 2)"));
    const latest = scheduler.schedule(latestInput);

    expect(timers.delays).toEqual([SEMANTIC_DELAY_MS, SEMANTIC_DELAY_MS]);
    timers.run();
    await latest;
    expect(await first).toBeInstanceOf(Error);
    expect(infer).toHaveBeenCalledOnce();
    expect(infer).toHaveBeenCalledWith(latestInput);
  });
});
