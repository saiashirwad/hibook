import type { NotebookDocument } from "../model/types";
import type {
  FastPrepareRequest,
  FastPrepareResponse,
  PreparedNotebook,
} from "./protocol";
import { revisionForDocument } from "./protocol";

export const EXECUTION_DEBOUNCE_MS = 120;

export interface FastWorkerLike {
  onmessage: ((event: { readonly data: FastPrepareResponse }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
  postMessage(message: FastPrepareRequest): void;
  terminate(): void;
}

export type FastWorkerFactory = () => FastWorkerLike;

interface PendingPreparation {
  readonly requestId: string;
  readonly revision: string;
  generation: number;
  readonly promise: Promise<PreparedNotebook>;
  readonly resolve: (prepared: PreparedNotebook) => void;
  readonly reject: (error: Error) => void;
}

interface CompletedPreparation {
  readonly prepared: PreparedNotebook;
  readonly promise: Promise<PreparedNotebook>;
}

export interface FastCoordinatorState {
  readonly workerConstructed: boolean;
  readonly workerConstructionCount: number;
  readonly pendingCount: number;
  readonly currentRevision: string | undefined;
  readonly disposed: boolean;
}

export class FastPreparationDisposedError extends Error {
  constructor() {
    super("Fast preparation coordinator has been disposed");
    this.name = "FastPreparationDisposedError";
  }
}

export class FastPreparationProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FastPreparationProtocolError";
  }
}

function createBrowserFastWorker(): FastWorkerLike {
  return new Worker(new URL("./fast-worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as FastWorkerLike;
}

export class FastPreparationCoordinator {
  readonly #workerFactory: FastWorkerFactory;
  readonly #pendingByRequest = new Map<string, PendingPreparation>();
  readonly #inFlightByRevision = new Map<string, PendingPreparation>();
  readonly #completedByRevision = new Map<string, CompletedPreparation>();
  #worker: FastWorkerLike | undefined;
  #workerConstructionCount = 0;
  #nextRequestId = 1;
  #generation = 0;
  #currentRevision: string | undefined;
  #currentPrepared: PreparedNotebook | undefined;
  #disposed = false;

  constructor(workerFactory: FastWorkerFactory = createBrowserFastWorker) {
    this.#workerFactory = workerFactory;
  }

  synchronize(document: NotebookDocument): string {
    if (this.#disposed) {
      throw new FastPreparationDisposedError();
    }
    const revision = revisionForDocument(document);
    this.#generation += 1;
    this.#currentRevision = revision;
    const completed = this.#completedByRevision.get(revision);
    this.#currentPrepared = completed?.prepared;
    const inFlight = this.#inFlightByRevision.get(revision);
    if (inFlight) {
      inFlight.generation = this.#generation;
    }
    return revision;
  }

  prepareFast(document: NotebookDocument): Promise<PreparedNotebook> {
    if (this.#disposed) {
      return Promise.reject(new FastPreparationDisposedError());
    }

    const revision = this.synchronize(document);
    const generation = this.#generation;

    const completed = this.#completedByRevision.get(revision);
    if (completed) {
      this.#currentPrepared = completed.prepared;
      return completed.promise;
    }

    const inFlight = this.#inFlightByRevision.get(revision);
    if (inFlight) {
      inFlight.generation = generation;
      return inFlight.promise;
    }

    const requestId = String(this.#nextRequestId);
    this.#nextRequestId += 1;
    let resolvePromise!: (prepared: PreparedNotebook) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<PreparedNotebook>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingPreparation = {
      requestId,
      revision,
      generation,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.#pendingByRequest.set(requestId, pending);
    this.#inFlightByRevision.set(revision, pending);

    try {
      const worker = this.#ensureWorker();
      worker.postMessage({
        type: "prepare",
        requestId,
        revision,
        document,
      });
    } catch (error) {
      this.#worker?.terminate();
      this.#worker = undefined;
      this.#settleRejected(
        pending,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return promise;
  }

  current(): PreparedNotebook | undefined {
    return this.#currentPrepared;
  }

  state(): FastCoordinatorState {
    return {
      workerConstructed: this.#worker !== undefined,
      workerConstructionCount: this.#workerConstructionCount,
      pendingCount: this.#pendingByRequest.size,
      currentRevision: this.#currentRevision,
      disposed: this.#disposed,
    };
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#rejectAll(new FastPreparationDisposedError());
    this.#currentPrepared = undefined;
  }

  #ensureWorker(): FastWorkerLike {
    if (this.#worker) {
      return this.#worker;
    }
    const worker = this.#workerFactory();
    this.#workerConstructionCount += 1;
    worker.onmessage = (event) => {
      this.#receive(event.data);
    };
    worker.onerror = (event) => {
      const message = event.message ?? "Fast preparation worker failed";
      worker.terminate();
      if (this.#worker === worker) {
        this.#worker = undefined;
      }
      this.#rejectAll(new Error(message));
    };
    this.#worker = worker;
    return worker;
  }

  #receive(response: FastPrepareResponse): void {
    const pending = this.#pendingByRequest.get(response.requestId);
    if (!pending) {
      const revisionMatch = this.#inFlightByRevision.get(response.revision);
      if (revisionMatch) {
        this.#settleRejected(
          revisionMatch,
          new FastPreparationProtocolError(
            `Fast preparation response request mismatch: expected ${revisionMatch.requestId}, received ${response.requestId}`,
          ),
        );
      }
      return;
    }
    if (response.revision !== pending.revision) {
      this.#settleRejected(
        pending,
        new FastPreparationProtocolError(
          `Fast preparation response revision mismatch for request ${pending.requestId}`,
        ),
      );
      return;
    }

    this.#removePending(pending);
    if (response.type === "failed") {
      pending.reject(new Error(response.error.message));
      return;
    }
    if (response.prepared.revision !== pending.revision) {
      pending.reject(
        new FastPreparationProtocolError(
          `Prepared notebook revision mismatch for request ${pending.requestId}`,
        ),
      );
      return;
    }

    if (
      pending.generation === this.#generation &&
      pending.revision === this.#currentRevision
    ) {
      this.#currentPrepared = response.prepared;
      this.#completedByRevision.set(pending.revision, {
        prepared: response.prepared,
        promise: pending.promise,
      });
    }
    pending.resolve(response.prepared);
  }

  #removePending(pending: PendingPreparation): void {
    this.#pendingByRequest.delete(pending.requestId);
    if (this.#inFlightByRevision.get(pending.revision) === pending) {
      this.#inFlightByRevision.delete(pending.revision);
    }
  }

  #settleRejected(pending: PendingPreparation, error: Error): void {
    this.#removePending(pending);
    pending.reject(error);
  }

  #rejectAll(error: Error): void {
    const pending = [...this.#pendingByRequest.values()];
    this.#pendingByRequest.clear();
    this.#inFlightByRevision.clear();
    for (const request of pending) {
      request.reject(error);
    }
  }
}

export class PreparationScheduleCancelledError extends Error {
  constructor(message = "Scheduled preparation was cancelled") {
    super(message);
    this.name = "PreparationScheduleCancelledError";
  }
}

export class PreparationScheduleReplacedError extends Error {
  constructor() {
    super("Scheduled preparation was replaced");
    this.name = "PreparationScheduleReplacedError";
  }
}

export interface PreparationTimerDriver {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

interface ScheduledPreparation {
  readonly handle: unknown;
  readonly reject: (error: Error) => void;
}

const DEFAULT_TIMER_DRIVER: PreparationTimerDriver = {
  set(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clear(handle) {
    globalThis.clearTimeout(handle as number);
  },
};

export class ExecutionPreparationScheduler {
  readonly #prepare: (document: NotebookDocument) => Promise<PreparedNotebook>;
  readonly #delayMs: number;
  readonly #timers: PreparationTimerDriver;
  #scheduled: ScheduledPreparation | undefined;

  constructor(
    prepare: (document: NotebookDocument) => Promise<PreparedNotebook>,
    delayMs = EXECUTION_DEBOUNCE_MS,
    timers: PreparationTimerDriver = DEFAULT_TIMER_DRIVER,
  ) {
    this.#prepare = prepare;
    this.#delayMs = delayMs;
    this.#timers = timers;
  }

  schedule(document: NotebookDocument): Promise<PreparedNotebook> {
    if (this.#scheduled) {
      this.#timers.clear(this.#scheduled.handle);
      this.#scheduled.reject(new PreparationScheduleReplacedError());
      this.#scheduled = undefined;
    }

    let resolvePromise!: (prepared: PreparedNotebook) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<PreparedNotebook>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const handle = this.#timers.set(() => {
      this.#scheduled = undefined;
      this.#prepare(document).then(resolvePromise, rejectPromise);
    }, this.#delayMs);
    this.#scheduled = { handle, reject: rejectPromise };
    return promise;
  }

  cancel(): boolean {
    if (!this.#scheduled) {
      return false;
    }
    this.#timers.clear(this.#scheduled.handle);
    this.#scheduled.reject(new PreparationScheduleCancelledError());
    this.#scheduled = undefined;
    return true;
  }
}
