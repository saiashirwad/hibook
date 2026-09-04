import type { CellId, NotebookDocument } from "../model/types";
import type { PreparedNotebook } from "./protocol";

export type SemanticCellStatus =
  | "text"
  | "explicit"
  | "inferred"
  | "invalid"
  | "cycle";

export type SemanticDiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface SemanticDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: SemanticDiagnosticSeverity;
  readonly message: string;
}

export interface SemanticCellResult {
  readonly cellId: CellId;
  readonly authoritative: true;
  readonly type: string;
  readonly status: SemanticCellStatus;
  readonly diagnostics: readonly SemanticDiagnostic[];
}

export interface SemanticCounters {
  readonly vfsWrites: number;
  readonly vfsSkips: number;
  readonly layers: number;
  readonly programBuilds: number;
  readonly reusedCells: number;
}

export interface SemanticTimings {
  readonly workerStartupMs: number;
  readonly projectSyncMs: number;
  readonly inferenceMs: number;
  readonly totalMs: number;
  readonly counters: SemanticCounters;
}

export interface SemanticNotebookResult {
  readonly revision: string;
  readonly cells: readonly SemanticCellResult[];
  readonly timings: SemanticTimings;
}

export interface SemanticProjectInput {
  readonly document: NotebookDocument;
  readonly prepared: PreparedNotebook;
  readonly changedCellIds?: readonly CellId[];
}

interface SemanticRequestBase extends SemanticProjectInput {
  readonly requestId: string;
  readonly revision: string;
}

export interface SemanticInferRequest extends SemanticRequestBase {
  readonly type: "infer";
}

export interface SemanticCompletionRequest extends SemanticRequestBase {
  readonly type: "completions";
  readonly cellId: CellId;
  readonly position: number;
}

export interface SemanticDiagnosticsRequest extends SemanticRequestBase {
  readonly type: "diagnostics";
  readonly cellId: CellId;
}

export interface SemanticQuickInfoRequest extends SemanticRequestBase {
  readonly type: "quickInfo";
  readonly cellId: CellId;
  readonly position: number;
}

export type SemanticRequest =
  | SemanticInferRequest
  | SemanticCompletionRequest
  | SemanticDiagnosticsRequest
  | SemanticQuickInfoRequest;

export interface SemanticCompletionItem {
  readonly label: string;
  readonly kind: string;
  readonly detail?: string;
  readonly applyText: string;
}

export interface SemanticCompletionResult {
  readonly from: number;
  readonly to: number;
  readonly items: readonly SemanticCompletionItem[];
}

export interface SemanticDisplayPart {
  readonly text: string;
  readonly kind: string;
}

export interface SemanticQuickInfo {
  readonly from: number;
  readonly to: number;
  readonly parts: readonly SemanticDisplayPart[];
  readonly documentation: string;
}

interface SemanticResponseBase {
  readonly requestId: string;
  readonly revision: string;
}

export interface SemanticInferResponse extends SemanticResponseBase {
  readonly type: "inferred";
  readonly semantic: SemanticNotebookResult;
}

export interface SemanticCompletionResponse extends SemanticResponseBase {
  readonly type: "completions";
  readonly semantic: SemanticNotebookResult;
  readonly completion: SemanticCompletionResult;
}

export interface SemanticDiagnosticsResponse extends SemanticResponseBase {
  readonly type: "diagnostics";
  readonly semantic: SemanticNotebookResult;
  readonly diagnostics: readonly SemanticDiagnostic[];
}

export interface SemanticQuickInfoResponse extends SemanticResponseBase {
  readonly type: "quickInfo";
  readonly semantic: SemanticNotebookResult;
  readonly quickInfo: SemanticQuickInfo | null;
}

export interface SemanticFailureResponse extends SemanticResponseBase {
  readonly type: "failed";
  readonly operation: SemanticRequest["type"];
  readonly error: {
    readonly message: string;
  };
}

export type SemanticResponse =
  | SemanticInferResponse
  | SemanticCompletionResponse
  | SemanticDiagnosticsResponse
  | SemanticQuickInfoResponse
  | SemanticFailureResponse;
