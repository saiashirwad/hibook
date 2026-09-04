/// <reference lib="webworker" />

import { SemanticProjectCore } from "./semantic-core";
import type {
  SemanticFailureResponse,
  SemanticRequest,
  SemanticResponse,
} from "./semantic-protocol";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let project: SemanticProjectCore | undefined;

function semanticProject(): SemanticProjectCore {
  project ??= new SemanticProjectCore();
  return project;
}

workerScope.onmessage = (event: MessageEvent<SemanticRequest>) => {
  const request = event.data;
  try {
    const core = semanticProject();
    let response: SemanticResponse;
    switch (request.type) {
      case "infer":
        response = {
          type: "inferred",
          requestId: request.requestId,
          revision: request.revision,
          semantic: core.infer(request, request.revision),
        };
        break;
      case "completions": {
        const result = core.completions(
          request,
          request.cellId,
          request.position,
          request.revision,
        );
        response = {
          type: "completions",
          requestId: request.requestId,
          revision: request.revision,
          ...result,
        };
        break;
      }
      case "diagnostics": {
        const result = core.diagnostics(
          request,
          request.cellId,
          request.revision,
        );
        response = {
          type: "diagnostics",
          requestId: request.requestId,
          revision: request.revision,
          ...result,
        };
        break;
      }
      case "quickInfo": {
        const result = core.quickInfo(
          request,
          request.cellId,
          request.position,
          request.revision,
        );
        response = {
          type: "quickInfo",
          requestId: request.requestId,
          revision: request.revision,
          ...result,
        };
        break;
      }
    }
    workerScope.postMessage(response);
  } catch (error) {
    const failure: SemanticFailureResponse = {
      type: "failed",
      operation: request.type,
      requestId: request.requestId,
      revision: request.revision,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
    workerScope.postMessage(failure);
  }
};
