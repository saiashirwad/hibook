import type { CellId, NotebookDocument } from "../model/types";
import { revisionForDocument } from "./protocol";
import type {
  SemanticCompletionRequest,
  SemanticCompletionResult,
  SemanticCompletionResponse,
  SemanticDiagnosticsRequest,
  SemanticDiagnosticsResponse,
  SemanticDiagnostic,
  SemanticInferRequest,
  SemanticInferResponse,
  SemanticNotebookResult,
  SemanticProjectInput,
  SemanticQuickInfo,
  SemanticQuickInfoRequest,
  SemanticQuickInfoResponse,
  SemanticRequest,
  SemanticResponse,
} from "./semantic-protocol";

export const SEMANTIC_DELAY_MS = 350;
export const SEMANTIC_COMPLETED_REVISION_LIMIT = 8;

export interface SemanticWorkerLike {
  onmessage: ((event: { readonly data: SemanticResponse }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
  postMessage(message: SemanticRequest): void;
  terminate(): void;
}

export type SemanticWorkerFactory = () => SemanticWorkerLike;

interface PendingRequest {
  readonly requestId: string;
  readonly revision: string;
  readonly operation: SemanticRequest["type"];
  readonly expectedResponse: Exclude<SemanticResponse["type"], "failed">;
  readonly generation: number;
  readonly promise: Promise<unknown>;
  readonly resolveResponse: (response: SemanticResponse) => void;
  readonly reject: (error: Error) => void;
}

interface CompletedInference {
  readonly result: SemanticNotebookResult;
  readonly promise: Promise<SemanticNotebookResult>;
}

export interface SemanticCoordinatorState {
  readonly workerConstructed: boolean;
  readonly workerConstructionCount: number;
  readonly pendingCount: number;
  readonly currentRevision: string | undefined;
  readonly disposed: boolean;
}

export class SemanticCoordinatorDisposedError extends Error {
  constructor() {
    super("Semantic coordinator has been disposed");
    this.name = "SemanticCoordinatorDisposedError";
  }
}

export class SemanticCoordinatorProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticCoordinatorProtocolError";
  }
}

export class StaleSemanticRequestError extends Error {
  constructor() {
    super("Semantic request no longer matches the current document revision");
    this.name = "StaleSemanticRequestError";
  }
}

function createBrowserSemanticWorker(): SemanticWorkerLike {
  return new Worker(new URL("./semantic-worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as SemanticWorkerLike;
}

function requestInput(
  input: SemanticProjectInput,
  requestId: string,
  revision: string,
): Omit<SemanticInferRequest, "type"> {
  return {
    requestId,
    revision,
    document: input.document,
    prepared: input.prepared,
    ...(input.changedCellIds === undefined
      ? {}
      : { changedCellIds: input.changedCellIds }),
  };
}

export class SemanticCoordinator {
  readonly #workerFactory: SemanticWorkerFactory;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #inferenceByRevision = new Map<string, Promise<SemanticNotebookResult>>();
  readonly #completedByRevision = new Map<string, CompletedInference>();
  #worker: SemanticWorkerLike | undefined;
  #workerConstructionCount = 0;
  #nextRequestId = 1;
  #generation = 0;
  #currentRevision: string | undefined;
  #currentResult: SemanticNotebookResult | undefined;
  #disposed = false;

  constructor(workerFactory: SemanticWorkerFactory = createBrowserSemanticWorker) {
    this.#workerFactory = workerFactory;
  }

  synchronize(document: NotebookDocument): string {
    if (this.#disposed) throw new SemanticCoordinatorDisposedError();
    const revision = revisionForDocument(document);
    if (revision === this.#currentRevision) return revision;
    this.#generation += 1;
    this.#currentRevision = revision;
    this.#currentResult = this.#completedByRevision.get(revision)?.result;
    const stale = [...this.#pending.values()].filter(
      (pending) => pending.revision !== revision,
    );
    for (const pending of stale) {
      this.#removePending(pending);
      pending.reject(new StaleSemanticRequestError());
    }
    return revision;
  }

  infer(input: SemanticProjectInput): Promise<SemanticNotebookResult> {
    if (this.#disposed) return Promise.reject(new SemanticCoordinatorDisposedError());
    const revision = this.#validateInput(input);
    const completed = this.#completedByRevision.get(revision);
    if (completed) {
      this.#currentResult = completed.result;
      return completed.promise;
    }
    const active = this.#inferenceByRevision.get(revision);
    if (active) return active;

    const requestId = this.#requestId();
    const request: SemanticInferRequest = {
      type: "infer",
      ...requestInput(input, requestId, revision),
    };
    const promise = this.#dispatch<SemanticNotebookResult>(
      request,
      "inferred",
      (response) => (response as SemanticInferResponse).semantic,
    );
    this.#inferenceByRevision.set(revision, promise);
    return promise;
  }

  completions(
    input: SemanticProjectInput,
    cellId: CellId,
    position: number,
  ): Promise<SemanticCompletionResult> {
    const revision = this.#validateInput(input);
    const requestId = this.#requestId();
    const request: SemanticCompletionRequest = {
      type: "completions",
      ...requestInput(input, requestId, revision),
      cellId,
      position,
    };
    return this.#dispatch(
      request,
      "completions",
      (response) => (response as SemanticCompletionResponse).completion,
    );
  }

  diagnostics(
    input: SemanticProjectInput,
    cellId: CellId,
  ): Promise<readonly SemanticDiagnostic[]> {
    const revision = this.#validateInput(input);
    const requestId = this.#requestId();
    const request: SemanticDiagnosticsRequest = {
      type: "diagnostics",
      ...requestInput(input, requestId, revision),
      cellId,
    };
    return this.#dispatch(
      request,
      "diagnostics",
      (response) => (response as SemanticDiagnosticsResponse).diagnostics,
    );
  }

  quickInfo(
    input: SemanticProjectInput,
    cellId: CellId,
    position: number,
  ): Promise<SemanticQuickInfo | undefined> {
    const revision = this.#validateInput(input);
    const requestId = this.#requestId();
    const request: SemanticQuickInfoRequest = {
      type: "quickInfo",
      ...requestInput(input, requestId, revision),
      cellId,
      position,
    };
    return this.#dispatch(
      request,
      "quickInfo",
      (response) => (response as SemanticQuickInfoResponse).quickInfo ?? undefined,
    );
  }

  current(): SemanticNotebookResult | undefined {
    return this.#currentResult;
  }

  state(): SemanticCoordinatorState {
    return {
      workerConstructed: this.#worker !== undefined,
      workerConstructionCount: this.#workerConstructionCount,
      pendingCount: this.#pending.size,
      currentRevision: this.#currentRevision,
      disposed: this.#disposed,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#rejectAll(new SemanticCoordinatorDisposedError());
    this.#currentResult = undefined;
  }

  #validateInput(input: SemanticProjectInput): string {
    if (this.#disposed) throw new SemanticCoordinatorDisposedError();
    const revision = this.synchronize(input.document);
    if (input.prepared.revision !== revision) {
      throw new SemanticCoordinatorProtocolError(
        "Semantic input prepared revision does not match the document",
      );
    }
    return revision;
  }

  #requestId(): string {
    const requestId = `semantic-${this.#nextRequestId}`;
    this.#nextRequestId += 1;
    return requestId;
  }

  #dispatch<T>(
    request: SemanticRequest,
    expectedResponse: PendingRequest["expectedResponse"],
    select: (response: SemanticResponse) => T,
  ): Promise<T> {
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingRequest = {
      requestId: request.requestId,
      revision: request.revision,
      operation: request.type,
      expectedResponse,
      generation: this.#generation,
      promise,
      resolveResponse(response) {
        resolvePromise(select(response));
      },
      reject: rejectPromise,
    };
    this.#pending.set(request.requestId, pending);
    try {
      this.#ensureWorker().postMessage(request);
    } catch (error) {
      this.#worker?.terminate();
      this.#worker = undefined;
      this.#removePending(pending);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  #ensureWorker(): SemanticWorkerLike {
    if (this.#worker) return this.#worker;
    const worker = this.#workerFactory();
    this.#workerConstructionCount += 1;
    worker.onmessage = (event) => this.#receive(event.data);
    worker.onerror = (event) => {
      worker.terminate();
      if (this.#worker === worker) this.#worker = undefined;
      this.#rejectAll(new Error(event.message ?? "Semantic worker failed"));
    };
    this.#worker = worker;
    return worker;
  }

  #receive(response: SemanticResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      const revisionMatch = [...this.#pending.values()].find(
        (candidate) => candidate.revision === response.revision,
      );
      if (revisionMatch) {
        this.#removePending(revisionMatch);
        revisionMatch.reject(
          new SemanticCoordinatorProtocolError(
            `Semantic response request mismatch: expected ${revisionMatch.requestId}, received ${response.requestId}`,
          ),
        );
      }
      return;
    }
    if (response.revision !== pending.revision) {
      this.#removePending(pending);
      pending.reject(
        new SemanticCoordinatorProtocolError(
          `Semantic response revision mismatch for request ${pending.requestId}`,
        ),
      );
      return;
    }
    if (
      pending.generation !== this.#generation ||
      pending.revision !== this.#currentRevision
    ) {
      this.#removePending(pending);
      pending.reject(new StaleSemanticRequestError());
      return;
    }
    if (response.type === "failed") {
      this.#removePending(pending);
      if (response.operation !== pending.operation) {
        pending.reject(
          new SemanticCoordinatorProtocolError(
            `Semantic failure operation mismatch for request ${pending.requestId}`,
          ),
        );
      } else {
        pending.reject(new Error(response.error.message));
      }
      return;
    }
    if (response.type !== pending.expectedResponse) {
      this.#removePending(pending);
      pending.reject(
        new SemanticCoordinatorProtocolError(
          `Semantic response operation mismatch for request ${pending.requestId}`,
        ),
      );
      return;
    }
    if (response.semantic.revision !== pending.revision) {
      this.#removePending(pending);
      pending.reject(
        new SemanticCoordinatorProtocolError(
          `Semantic result revision mismatch for request ${pending.requestId}`,
        ),
      );
      return;
    }

    this.#removePending(pending);
    this.#currentResult = response.semantic;
    const semanticPromise =
      pending.operation === "infer"
        ? (pending.promise as Promise<SemanticNotebookResult>)
        : Promise.resolve(response.semantic);
    this.#rememberCompleted(pending.revision, {
      result: response.semantic,
      promise: semanticPromise,
    });
    pending.resolveResponse(response);
  }

  #removePending(pending: PendingRequest): void {
    this.#pending.delete(pending.requestId);
    if (pending.operation === "infer") {
      this.#inferenceByRevision.delete(pending.revision);
    }
  }

  #rememberCompleted(
    revision: string,
    completed: CompletedInference,
  ): void {
    this.#completedByRevision.delete(revision);
    this.#completedByRevision.set(revision, completed);
    while (
      this.#completedByRevision.size > SEMANTIC_COMPLETED_REVISION_LIMIT
    ) {
      const oldestRevision = this.#completedByRevision.keys().next().value;
      if (oldestRevision === undefined) break;
      this.#completedByRevision.delete(oldestRevision);
    }
  }

  #rejectAll(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#inferenceByRevision.clear();
    for (const request of pending) request.reject(error);
  }
}

export interface SemanticTimerDriver {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMER_DRIVER: SemanticTimerDriver = {
  set(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clear(handle) {
    globalThis.clearTimeout(handle as number);
  },
};

interface ScheduledInference {
  readonly handle: unknown;
  readonly reject: (error: Error) => void;
}

export class SemanticScheduleCancelledError extends Error {
  constructor() {
    super("Scheduled semantic inference was cancelled");
    this.name = "SemanticScheduleCancelledError";
  }
}

export class SemanticScheduleReplacedError extends Error {
  constructor() {
    super("Scheduled semantic inference was replaced");
    this.name = "SemanticScheduleReplacedError";
  }
}

export class SemanticInferenceScheduler {
  readonly #infer: (input: SemanticProjectInput) => Promise<SemanticNotebookResult>;
  readonly #delayMs: number;
  readonly #timers: SemanticTimerDriver;
  #scheduled: ScheduledInference | undefined;

  constructor(
    infer: (input: SemanticProjectInput) => Promise<SemanticNotebookResult>,
    delayMs = SEMANTIC_DELAY_MS,
    timers: SemanticTimerDriver = DEFAULT_TIMER_DRIVER,
  ) {
    this.#infer = infer;
    this.#delayMs = delayMs;
    this.#timers = timers;
  }

  schedule(input: SemanticProjectInput): Promise<SemanticNotebookResult> {
    if (this.#scheduled) {
      this.#timers.clear(this.#scheduled.handle);
      this.#scheduled.reject(new SemanticScheduleReplacedError());
      this.#scheduled = undefined;
    }
    let resolvePromise!: (result: SemanticNotebookResult) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<SemanticNotebookResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const handle = this.#timers.set(() => {
      this.#scheduled = undefined;
      this.#infer(input).then(resolvePromise, rejectPromise);
    }, this.#delayMs);
    this.#scheduled = { handle, reject: rejectPromise };
    return promise;
  }

  cancel(): boolean {
    if (!this.#scheduled) return false;
    this.#timers.clear(this.#scheduled.handle);
    this.#scheduled.reject(new SemanticScheduleCancelledError());
    this.#scheduled = undefined;
    return true;
  }
}
