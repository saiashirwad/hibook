export type CellId = string;

export type CellKind = "text" | "javascript" | "markdown";

export interface Cell {
  readonly id: CellId;
  readonly kind: CellKind;
  readonly name?: string;
  readonly source: string;
  readonly classes: string[];
  readonly metadata: Record<string, unknown>;
  readonly children: CellId[];
}

export interface NotebookDocument {
  readonly rootId: CellId;
  readonly cells: Record<CellId, Cell>;
}

export interface CellInput {
  readonly id: CellId;
  readonly kind: CellKind;
  readonly name?: string;
  readonly source: string;
  readonly classes: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CellPatch {
  readonly kind?: CellKind;
  readonly name?: string;
  readonly source?: string;
  readonly classes?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SiblingPosition = "before" | "after";

export type MoveTarget =
  | {
      readonly type: "child";
      readonly parentId: CellId;
      readonly index?: number;
    }
  | {
      readonly type: "sibling";
      readonly referenceId: CellId;
      readonly position: SiblingPosition;
    };

export type ValidationErrorCode =
  | "DOCUMENT_NOT_OBJECT"
  | "ROOT_ID_MISSING"
  | "CELLS_MISSING"
  | "ROOT_NOT_FOUND"
  | "ROOT_CELL_ID_MISMATCH"
  | "ROOT_HAS_PARENT"
  | "CELL_NOT_OBJECT"
  | "CELL_ID_INVALID"
  | "CELL_KEY_MISMATCH"
  | "DUPLICATE_CELL_ID"
  | "CELL_KIND_INVALID"
  | "CELL_SOURCE_INVALID"
  | "CELL_CLASSES_INVALID"
  | "CELL_METADATA_INVALID"
  | "CELL_METADATA_NOT_SERIALIZABLE"
  | "CELL_CHILDREN_INVALID"
  | "CELL_NAME_INVALID"
  | "CELL_NAME_RESERVED"
  | "CHILD_ID_INVALID"
  | "DANGLING_CHILD"
  | "DUPLICATE_CHILD"
  | "MULTIPLE_PARENTS"
  | "UNREACHABLE_CELL"
  | "CYCLE"
  | "SIBLING_NAME_CONFLICT"
  | "VALIDATION_EXCEPTION";

export interface ValidationDiagnostic {
  readonly code: ValidationErrorCode;
  readonly path: string;
  readonly message: string;
  readonly cellId?: CellId;
  readonly relatedCellId?: CellId;
}

export type ValidationResult =
  | {
      readonly valid: true;
      readonly diagnostics: readonly [];
    }
  | {
      readonly valid: false;
      readonly diagnostics: readonly ValidationDiagnostic[];
    };

export type CommandErrorCode =
  | "INVALID_DOCUMENT"
  | "INVALID_CELL"
  | "INVALID_PATCH"
  | "INVALID_TARGET"
  | "INVALID_INDEX"
  | "CELL_NOT_FOUND"
  | "PARENT_NOT_FOUND"
  | "DUPLICATE_ID"
  | "ROOT_PROTECTED"
  | "ROOT_HAS_NO_SIBLINGS"
  | "MOVE_INTO_SELF_OR_DESCENDANT"
  | "INVALID_NAME"
  | "RESERVED_NAME"
  | "NAME_CONFLICT";

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
  readonly cellId?: CellId;
  readonly relatedCellId?: CellId;
  readonly diagnostics?: readonly ValidationDiagnostic[];
}

export type CommandResult =
  | {
      readonly ok: true;
      readonly document: NotebookDocument;
    }
  | {
      readonly ok: false;
      readonly error: CommandError;
    };

export type ParentLookupResult =
  | {
      readonly ok: true;
      readonly parentId: CellId | undefined;
    }
  | {
      readonly ok: false;
      readonly error: CommandError;
    };

export type RandomSource = () => number;

export interface CommandOptions {
  readonly random?: RandomSource;
}
