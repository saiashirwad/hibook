import { describe, expect, it, vi } from "vitest";
import type { Cell, NotebookDocument } from "../model/types";
import { prepareExecution } from "./fast-prepare";
import {
  EXECUTION_DEBOUNCE_MS,
  ExecutionPreparationScheduler,
  FastPreparationCoordinator,
  FastPreparationDisposedError,
  FastPreparationProtocolError,
  PreparationScheduleCancelledError,
  PreparationScheduleReplacedError,
} from "./coordinator";
import type {
  FastWorkerLike,
  PreparationTimerDriver,
} from "./coordinator";
import type {
  FastPrepareRequest,
  FastPrepareResponse,
  PreparedNotebook,
} from "./protocol";

function document(source: string): NotebookDocument {
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

class ControlledWorker implements FastWorkerLike {
  onmessage: ((event: { readonly data: FastPrepareResponse }) => void) | null =
    null;
  onerror: ((event: { readonly message?: string }) => void) | null = null;
  readonly requests: FastPrepareRequest[] = [];
  terminated = false;

  postMessage(message: FastPrepareRequest): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  succeed(request: FastPrepareRequest): PreparedNotebook {
    const prepared = prepareExecution(request.document);
    this.onmessage?.({
      data: {
        type: "prepared",
        requestId: request.requestId,
        revision: request.revision,
        prepared,
      },
    });
    return prepared;
  }

  fail(request: FastPrepareRequest, message: string): void {
    this.onmessage?.({
      data: {
        type: "failed",
        requestId: request.requestId,
        revision: request.revision,
        error: { message },
      },
    });
  }
}

class ManualTimers implements PreparationTimerDriver {
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

  runAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

describe("fast preparation coordinator", () => {
  it("constructs no worker until preparation is requested", () => {
    let constructions = 0;
    const coordinator = new FastPreparationCoordinator(() => {
      constructions += 1;
      return new ControlledWorker();
    });

    expect(constructions).toBe(0);
    expect(coordinator.current()).toBeUndefined();
    coordinator.synchronize(document("$(() => 1)"));
    expect(coordinator.current()).toBeUndefined();
    expect(coordinator.state()).toMatchObject({
      workerConstructed: false,
      workerConstructionCount: 0,
      pendingCount: 0,
    });
  });

  it("coalesces an exact in-flight revision with strict Promise identity and reuses its completed result", async () => {
    const worker = new ControlledWorker();
    const coordinator = new FastPreparationCoordinator(() => worker);
    const notebook = document("$(() => 1)");

    const first = coordinator.prepareFast(notebook);
    const second = coordinator.prepareFast(notebook);
    expect(second).toBe(first);
    expect(worker.requests).toHaveLength(1);

    const expected = worker.succeed(worker.requests[0]!);
    await expect(first).resolves.toBe(expected);
    expect(coordinator.current()).toBe(expected);

    const completed = coordinator.prepareFast(notebook);
    expect(completed).toBe(first);
    expect(worker.requests).toHaveLength(1);
    await expect(completed).resolves.toBe(expected);
    expect(coordinator.state()).toMatchObject({
      workerConstructed: true,
      workerConstructionCount: 1,
      pendingCount: 0,
    });
  });

  it("settles stale callers without publishing or caching their late response", async () => {
    const worker = new ControlledWorker();
    const coordinator = new FastPreparationCoordinator(() => worker);
    const oldDocument = document("$(() => 1)");
    const newDocument = document("$(() => 2)");
    const oldPromise = coordinator.prepareFast(oldDocument);
    const newPromise = coordinator.prepareFast(newDocument);
    const oldRequest = worker.requests[0]!;
    const newRequest = worker.requests[1]!;

    const newer = worker.succeed(newRequest);
    await expect(newPromise).resolves.toBe(newer);
    const older = worker.succeed(oldRequest);
    await expect(oldPromise).resolves.toBe(older);
    expect(coordinator.current()).toBe(newer);

    const repeatedOld = coordinator.prepareFast(oldDocument);
    expect(worker.requests).toHaveLength(3);
    expect(repeatedOld).not.toBe(oldPromise);
    worker.succeed(worker.requests[2]!);
    await repeatedOld;
  });

  it("rejects request and revision mismatches instead of accepting unrelated output", async () => {
    const worker = new ControlledWorker();
    const coordinator = new FastPreparationCoordinator(() => worker);
    const notebook = document("$(() => 1)");
    const wrongRequestPromise = coordinator.prepareFast(notebook);
    const request = worker.requests[0]!;
    const prepared = prepareExecution(notebook);
    worker.onmessage?.({
      data: {
        type: "prepared",
        requestId: "not-the-request",
        revision: request.revision,
        prepared,
      },
    });
    await expect(wrongRequestPromise).rejects.toBeInstanceOf(
      FastPreparationProtocolError,
    );

    const wrongRevisionPromise = coordinator.prepareFast(notebook);
    const secondRequest = worker.requests[1]!;
    worker.onmessage?.({
      data: {
        type: "prepared",
        requestId: secondRequest.requestId,
        revision: "wrong revision",
        prepared,
      },
    });
    await expect(wrongRevisionPromise).rejects.toBeInstanceOf(
      FastPreparationProtocolError,
    );
    expect(coordinator.current()).toBeUndefined();
  });

  it("rejects typed worker failures, worker crashes, and pending work on disposal", async () => {
    const firstWorker = new ControlledWorker();
    const secondWorker = new ControlledWorker();
    const workers = [firstWorker, secondWorker];
    const coordinator = new FastPreparationCoordinator(() => workers.shift()!);

    const typedFailure = coordinator.prepareFast(document("$(() => 1)"));
    firstWorker.fail(firstWorker.requests[0]!, "could not prepare");
    await expect(typedFailure).rejects.toThrow("could not prepare");

    const crashed = coordinator.prepareFast(document("$(() => 2)"));
    firstWorker.onerror?.({ message: "worker crashed" });
    await expect(crashed).rejects.toThrow("worker crashed");
    expect(firstWorker.terminated).toBe(true);

    const disposed = coordinator.prepareFast(document("$(() => 3)"));
    expect(secondWorker.requests).toHaveLength(1);
    coordinator.dispose();
    await expect(disposed).rejects.toBeInstanceOf(FastPreparationDisposedError);
    expect(secondWorker.terminated).toBe(true);
    await expect(
      coordinator.prepareFast(document("$(() => 4)")),
    ).rejects.toBeInstanceOf(FastPreparationDisposedError);
  });
});

describe("execution preparation scheduler", () => {
  it("replaces pending work and waits exactly the execution debounce", async () => {
    const timers = new ManualTimers();
    const prepare = vi.fn((notebook: NotebookDocument) =>
      Promise.resolve(prepareExecution(notebook)),
    );
    const scheduler = new ExecutionPreparationScheduler(
      prepare,
      EXECUTION_DEBOUNCE_MS,
      timers,
    );
    const first = scheduler.schedule(document("$(() => 1)")).catch(
      (error: unknown) => error,
    );
    const replacementDocument = document("$(() => 2)");
    const replacement = scheduler.schedule(replacementDocument);

    await expect(first).resolves.toBeInstanceOf(
      PreparationScheduleReplacedError,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(timers.delays).toEqual([
      EXECUTION_DEBOUNCE_MS,
      EXECUTION_DEBOUNCE_MS,
    ]);

    timers.runAll();
    await replacement;
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(replacementDocument);
  });

  it("cancels pending work without invoking preparation", async () => {
    const timers = new ManualTimers();
    const prepare = vi.fn((notebook: NotebookDocument) =>
      Promise.resolve(prepareExecution(notebook)),
    );
    const scheduler = new ExecutionPreparationScheduler(
      prepare,
      EXECUTION_DEBOUNCE_MS,
      timers,
    );
    const scheduled = scheduler.schedule(document("$(() => 1)")).catch(
      (error: unknown) => error,
    );

    expect(scheduler.cancel()).toBe(true);
    expect(scheduler.cancel()).toBe(false);
    timers.runAll();
    await expect(scheduled).resolves.toBeInstanceOf(
      PreparationScheduleCancelledError,
    );
    expect(prepare).not.toHaveBeenCalled();
  });
});
