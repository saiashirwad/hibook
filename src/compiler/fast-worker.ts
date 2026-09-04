import { FastPreparationCore } from "./fast-prepare";
import type {
  FastPrepareFailure,
  FastPrepareRequest,
  FastPrepareResponse,
} from "./protocol";
import { revisionForDocument } from "./protocol";

interface FastWorkerScope {
  onmessage: ((event: { readonly data: FastPrepareRequest }) => void) | null;
  postMessage(message: FastPrepareResponse): void;
}

const workerScope = globalThis as unknown as FastWorkerScope;
const preparation = new FastPreparationCore();

workerScope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.type !== "prepare") {
      throw new Error("Unsupported fast preparation request");
    }
    if (revisionForDocument(request.document) !== request.revision) {
      throw new Error("Fast preparation request revision does not match document");
    }
    workerScope.postMessage({
      type: "prepared",
      requestId: request.requestId,
      revision: request.revision,
      prepared: preparation.prepare(request.document, request.revision),
    });
  } catch (error) {
    const failure: FastPrepareFailure = {
      type: "failed",
      requestId:
        typeof request?.requestId === "string" ? request.requestId : "",
      revision: typeof request?.revision === "string" ? request.revision : "",
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
    workerScope.postMessage(failure);
  }
};
