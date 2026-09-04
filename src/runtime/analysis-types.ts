import type { CellId, CellKind } from "../model/types";

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export type NotebookPathOriginKind = "root" | "parent" | "self";

export interface NotebookPathOrigin {
  readonly kind: NotebookPathOriginKind;
  readonly span: SourceSpan;
}

export type NotebookPathHop =
  | {
      readonly kind: "child";
      readonly name: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "children";
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "dynamic";
      readonly span: SourceSpan;
    };

export interface NotebookPath {
  readonly origin: NotebookPathOrigin;
  readonly hops: readonly NotebookPathHop[];
  readonly valueSpan: SourceSpan;
  readonly span: SourceSpan;
}

export type InvalidPathReason =
  | "analyzed-cell-missing"
  | "root-missing"
  | "children-segment-without-name"
  | "cell-children-invalid";

export type PathResolution =
  | {
      readonly status: "resolved";
      readonly targetId: CellId;
    }
  | {
      readonly status: "missing";
      readonly at: "parent" | "child";
      readonly span: SourceSpan;
      readonly fromId?: CellId;
      readonly name?: string;
    }
  | {
      readonly status: "ambiguous";
      readonly at: "parent" | "child";
      readonly span: SourceSpan;
      readonly candidateIds: readonly CellId[];
      readonly fromId?: CellId;
      readonly name?: string;
    }
  | {
      readonly status: "dynamic";
      readonly span: SourceSpan;
    }
  | {
      readonly status: "invalid";
      readonly reason: InvalidPathReason;
      readonly span: SourceSpan;
    };

export type DependencyIssueClassification =
  | "syntax"
  | "missing"
  | "ambiguous"
  | "dynamic"
  | "invalid"
  | "aliased";

export type DependencyIssueCode =
  | "SYNTAX_ERROR"
  | "CALLBACK_REQUIRED"
  | "MULTIPLE_CALLBACKS"
  | "INVALID_CALLBACK"
  | "INVALID_CONTEXT_PARAMETER"
  | "ALIASED_CONTEXT"
  | "MISSING_TARGET"
  | "AMBIGUOUS_TARGET"
  | "DYNAMIC_PATH"
  | "INVALID_PATH";

export interface DependencyIssue {
  readonly classification: DependencyIssueClassification;
  readonly code: DependencyIssueCode;
  readonly message: string;
  readonly span: SourceSpan;
}

export interface ExplicitAnnotation {
  readonly text: string;
  readonly span: SourceSpan;
}

export interface DependencyReference {
  readonly path: NotebookPath;
  readonly resolution: PathResolution;
}

export interface CellDependencyAnalysis {
  readonly cellId: CellId;
  readonly kind: CellKind;
  readonly dependencies: readonly CellId[];
  readonly references: readonly DependencyReference[];
  readonly issues: readonly DependencyIssue[];
  readonly annotation?: ExplicitAnnotation;
}

export interface DependencyCycleGroup {
  readonly cellIds: readonly CellId[];
}

export interface NotebookGraphResult {
  readonly order: readonly CellId[];
  readonly analyses: ReadonlyMap<CellId, CellDependencyAnalysis>;
  readonly dependencies: ReadonlyMap<CellId, readonly CellId[]>;
  readonly dependents: ReadonlyMap<CellId, readonly CellId[]>;
  readonly layers: readonly (readonly CellId[])[];
  readonly cycleGroups: readonly DependencyCycleGroup[];
  readonly cycleMembers: readonly CellId[];
  readonly blockedByCycles: readonly CellId[];
}
