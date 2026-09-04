import { generateCellName, validateCellName } from "./names";
import type {
  Cell,
  CellId,
  CellInput,
  CellKind,
  CellPatch,
  CommandError,
  CommandOptions,
  CommandResult,
  MoveTarget,
  NotebookDocument,
  ParentLookupResult,
  RandomSource,
} from "./types";
import {
  isPlainRecord,
  isSerializableValue,
  validateNotebook,
} from "./validate";

const VALID_KINDS: Record<CellKind, true> = {
  text: true,
  javascript: true,
  markdown: true,
};

const CELL_INPUT_KEYS: Record<keyof CellInput, true> = {
  id: true,
  kind: true,
  name: true,
  source: true,
  classes: true,
  metadata: true,
};

const CELL_PATCH_KEYS: Record<keyof CellPatch, true> = {
  kind: true,
  name: true,
  source: true,
  classes: true,
  metadata: true,
};

type PreparedCellResult =
  | { readonly ok: true; readonly cell: Cell }
  | { readonly ok: false; readonly error: CommandError };

type DestinationResult =
  | {
      readonly ok: true;
      readonly parentId: CellId;
      readonly insertionIndex: number;
    }
  | { readonly ok: false; readonly error: CommandError };

function commandError(
  code: CommandError["code"],
  message: string,
  cellId?: CellId,
  relatedCellId?: CellId,
): CommandError {
  return {
    code,
    message,
    ...(cellId === undefined ? {} : { cellId }),
    ...(relatedCellId === undefined ? {} : { relatedCellId }),
  };
}

function rejected(error: CommandError): CommandResult {
  return { ok: false, error };
}

function invalidDocument(document: NotebookDocument): CommandResult | undefined {
  const validation = validateNotebook(document);
  if (validation.valid) {
    return undefined;
  }
  return {
    ok: false,
    error: {
      code: "INVALID_DOCUMENT",
      message: "Notebook document is malformed.",
      diagnostics: validation.diagnostics,
    },
  };
}

function cloneSerializableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneSerializableValue);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(
        ([key, item]) =>
          [key, cloneSerializableValue(item)] as const,
      ),
    );
  }
  return value;
}

function prepareCell(input: CellInput): PreparedCellResult {
  if (!isPlainRecord(input)) {
    return {
      ok: false,
      error: commandError("INVALID_CELL", "New cell must be an object."),
    };
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => !Object.hasOwn(CELL_INPUT_KEYS, key),
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: commandError(
        "INVALID_CELL",
        `New cell contains unsupported field ${JSON.stringify(unknownKeys[0])}.`,
      ),
    };
  }

  if (typeof input.id !== "string" || input.id.length === 0) {
    return {
      ok: false,
      error: commandError(
        "INVALID_CELL",
        "New cell id must be a non-empty string.",
      ),
    };
  }
  if (
    typeof input.kind !== "string" ||
    !Object.hasOwn(VALID_KINDS, input.kind)
  ) {
    return {
      ok: false,
      error: commandError(
        "INVALID_CELL",
        "New cell kind must be text, javascript, or markdown.",
        input.id,
      ),
    };
  }
  if (typeof input.source !== "string") {
    return {
      ok: false,
      error: commandError(
        "INVALID_CELL",
        "New cell source must be a string.",
        input.id,
      ),
    };
  }
  if (
    !Array.isArray(input.classes) ||
    !input.classes.every((className) => typeof className === "string")
  ) {
    return {
      ok: false,
      error: commandError(
        "INVALID_CELL",
        "New cell classes must be an array of strings.",
        input.id,
      ),
    };
  }
  if (!isPlainRecord(input.metadata) || !isSerializableValue(input.metadata)) {
    return {
      ok: false,
      error: commandError(
        "INVALID_CELL",
        "New cell metadata must be a serializable object.",
        input.id,
      ),
    };
  }

  let name: string | undefined;
  if (Object.hasOwn(input, "name")) {
    if (typeof input.name !== "string") {
      return {
        ok: false,
        error: commandError(
          "INVALID_NAME",
          "Cell name must be a JavaScript identifier.",
          input.id,
        ),
      };
    }
    const validation = validateCellName(input.name);
    if (!validation.valid) {
      return {
        ok: false,
        error: commandError(
          validation.problem === "reserved" ? "RESERVED_NAME" : "INVALID_NAME",
          validation.problem === "reserved"
            ? `Cell name ${JSON.stringify(input.name)} is reserved by notebook handles.`
            : `Cell name ${JSON.stringify(input.name)} is not a JavaScript identifier.`,
          input.id,
        ),
      };
    }
    name = input.name;
  }

  return {
    ok: true,
    cell: {
      id: input.id,
      kind: input.kind,
      ...(name === undefined ? {} : { name }),
      source: input.source,
      classes: [...input.classes],
      metadata: cloneSerializableValue(input.metadata) as Record<string, unknown>,
      children: [],
    },
  };
}

function cellAt(document: NotebookDocument, cellId: CellId): Cell {
  return document.cells[cellId] as Cell;
}

function nameSetForChildren(
  document: NotebookDocument,
  parentId: CellId,
  excludedId?: CellId,
): Set<string> {
  const names = new Set<string>();
  for (const childId of cellAt(document, parentId).children) {
    if (childId === excludedId) {
      continue;
    }
    const name = cellAt(document, childId).name;
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

function addResolvedName(
  cell: Cell,
  existingNames: ReadonlySet<string>,
  random?: RandomSource,
): PreparedCellResult {
  if (cell.name !== undefined) {
    if (existingNames.has(cell.name)) {
      return {
        ok: false,
        error: commandError(
          "NAME_CONFLICT",
          `Sibling name ${JSON.stringify(cell.name)} is already in use.`,
          cell.id,
        ),
      };
    }
    return { ok: true, cell };
  }

  return {
    ok: true,
    cell: {
      ...cell,
      name: generateCellName(existingNames, random),
    },
  };
}

function hasCell(document: NotebookDocument, cellId: CellId): boolean {
  return Object.hasOwn(document.cells, cellId);
}

function findParentId(
  document: NotebookDocument,
  cellId: CellId,
): CellId | undefined {
  for (const cell of Object.values(document.cells)) {
    if (cell.children.includes(cellId)) {
      return cell.id;
    }
  }
  return undefined;
}

function collectSubtreeIds(
  document: NotebookDocument,
  cellId: CellId,
): Set<CellId> {
  const subtree = new Set<CellId>();
  const pending = [cellId];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || subtree.has(current)) {
      continue;
    }
    subtree.add(current);
    pending.push(...cellAt(document, current).children);
  }
  return subtree;
}

function resolveMoveDestination(
  document: NotebookDocument,
  movingId: CellId,
  sourceParentId: CellId,
  target: MoveTarget,
  subtreeIds: ReadonlySet<CellId>,
): DestinationResult {
  if (!isPlainRecord(target)) {
    return {
      ok: false,
      error: commandError("INVALID_TARGET", "Move target must be an object."),
    };
  }

  if (target.type === "child") {
    const unknownKeys = Object.keys(target).filter(
      (key) => key !== "type" && key !== "parentId" && key !== "index",
    );
    if (
      unknownKeys.length > 0 ||
      typeof target.parentId !== "string" ||
      (Object.hasOwn(target, "index") &&
        (target.index === undefined || !Number.isInteger(target.index)))
    ) {
      return {
        ok: false,
        error: commandError(
          "INVALID_TARGET",
          "Child move target requires a parentId and optional integer index.",
          movingId,
        ),
      };
    }
    if (!hasCell(document, target.parentId)) {
      return {
        ok: false,
        error: commandError(
          "PARENT_NOT_FOUND",
          `Destination parent ${JSON.stringify(target.parentId)} does not exist.`,
          movingId,
          target.parentId,
        ),
      };
    }
    if (subtreeIds.has(target.parentId)) {
      return {
        ok: false,
        error: commandError(
          "MOVE_INTO_SELF_OR_DESCENDANT",
          "A cell cannot move into itself or one of its descendants.",
          movingId,
          target.parentId,
        ),
      };
    }

    const destinationLength =
      cellAt(document, target.parentId).children.length -
      (target.parentId === sourceParentId ? 1 : 0);
    const insertionIndex = target.index ?? destinationLength;
    if (insertionIndex < 0 || insertionIndex > destinationLength) {
      return {
        ok: false,
        error: commandError(
          "INVALID_INDEX",
          `Child insertion index must be between 0 and ${destinationLength}.`,
          movingId,
          target.parentId,
        ),
      };
    }
    return { ok: true, parentId: target.parentId, insertionIndex };
  }

  if (target.type === "sibling") {
    const unknownKeys = Object.keys(target).filter(
      (key) => key !== "type" && key !== "referenceId" && key !== "position",
    );
    if (
      unknownKeys.length > 0 ||
      typeof target.referenceId !== "string" ||
      (target.position !== "before" && target.position !== "after")
    ) {
      return {
        ok: false,
        error: commandError(
          "INVALID_TARGET",
          "Sibling move target requires a referenceId and before/after position.",
          movingId,
        ),
      };
    }
    if (!hasCell(document, target.referenceId)) {
      return {
        ok: false,
        error: commandError(
          "CELL_NOT_FOUND",
          `Reference cell ${JSON.stringify(target.referenceId)} does not exist.`,
          target.referenceId,
        ),
      };
    }
    if (target.referenceId === document.rootId) {
      return {
        ok: false,
        error: commandError(
          "ROOT_HAS_NO_SIBLINGS",
          "The root cell cannot be used as a sibling target.",
          target.referenceId,
        ),
      };
    }
    if (subtreeIds.has(target.referenceId)) {
      return {
        ok: false,
        error: commandError(
          "MOVE_INTO_SELF_OR_DESCENDANT",
          "A cell cannot target itself or one of its descendants.",
          movingId,
          target.referenceId,
        ),
      };
    }

    const parentId = findParentId(document, target.referenceId);
    if (parentId === undefined) {
      return {
        ok: false,
        error: commandError(
          "PARENT_NOT_FOUND",
          "Sibling target has no parent.",
          target.referenceId,
        ),
      };
    }
    const destinationChildren = cellAt(document, parentId).children.filter(
      (childId) => childId !== movingId,
    );
    const referenceIndex = destinationChildren.indexOf(target.referenceId);
    return {
      ok: true,
      parentId,
      insertionIndex:
        referenceIndex + (target.position === "after" ? 1 : 0),
    };
  }

  return {
    ok: false,
    error: commandError(
      "INVALID_TARGET",
      "Move target type must be child or sibling.",
      movingId,
    ),
  };
}

export function createNotebook(
  root: CellInput,
  options: CommandOptions = {},
): CommandResult {
  const prepared = prepareCell(root);
  if (!prepared.ok) {
    return rejected(prepared.error);
  }
  const named = addResolvedName(prepared.cell, new Set(), options.random);
  if (!named.ok) {
    return rejected(named.error);
  }
  return {
    ok: true,
    document: {
      rootId: named.cell.id,
      cells: { [named.cell.id]: named.cell },
    },
  };
}

export function appendChild(
  document: NotebookDocument,
  parentId: CellId,
  input: CellInput,
  options: CommandOptions = {},
): CommandResult {
  const malformed = invalidDocument(document);
  if (malformed !== undefined) {
    return malformed;
  }
  if (!hasCell(document, parentId)) {
    return rejected(
      commandError(
        "PARENT_NOT_FOUND",
        `Parent ${JSON.stringify(parentId)} does not exist.`,
        parentId,
      ),
    );
  }

  const prepared = prepareCell(input);
  if (!prepared.ok) {
    return rejected(prepared.error);
  }
  if (hasCell(document, prepared.cell.id)) {
    return rejected(
      commandError(
        "DUPLICATE_ID",
        `Cell id ${JSON.stringify(prepared.cell.id)} already exists.`,
        prepared.cell.id,
      ),
    );
  }

  const named = addResolvedName(
    prepared.cell,
    nameSetForChildren(document, parentId),
    options.random,
  );
  if (!named.ok) {
    return rejected(named.error);
  }

  const parent = cellAt(document, parentId);
  return {
    ok: true,
    document: {
      rootId: document.rootId,
      cells: {
        ...document.cells,
        [parentId]: {
          ...parent,
          children: [...parent.children, named.cell.id],
        },
        [named.cell.id]: named.cell,
      },
    },
  };
}

export function insertSibling(
  document: NotebookDocument,
  referenceId: CellId,
  position: "before" | "after",
  input: CellInput,
  options: CommandOptions = {},
): CommandResult {
  const malformed = invalidDocument(document);
  if (malformed !== undefined) {
    return malformed;
  }
  if (!hasCell(document, referenceId)) {
    return rejected(
      commandError(
        "CELL_NOT_FOUND",
        `Reference cell ${JSON.stringify(referenceId)} does not exist.`,
        referenceId,
      ),
    );
  }
  if (referenceId === document.rootId) {
    return rejected(
      commandError(
        "ROOT_HAS_NO_SIBLINGS",
        "The root cell cannot be given siblings.",
        referenceId,
      ),
    );
  }
  if (position !== "before" && position !== "after") {
    return rejected(
      commandError(
        "INVALID_TARGET",
        "Sibling position must be before or after.",
        referenceId,
      ),
    );
  }

  const parentId = findParentId(document, referenceId);
  if (parentId === undefined) {
    return rejected(
      commandError("PARENT_NOT_FOUND", "Reference cell has no parent.", referenceId),
    );
  }
  const prepared = prepareCell(input);
  if (!prepared.ok) {
    return rejected(prepared.error);
  }
  if (hasCell(document, prepared.cell.id)) {
    return rejected(
      commandError(
        "DUPLICATE_ID",
        `Cell id ${JSON.stringify(prepared.cell.id)} already exists.`,
        prepared.cell.id,
      ),
    );
  }

  const named = addResolvedName(
    prepared.cell,
    nameSetForChildren(document, parentId),
    options.random,
  );
  if (!named.ok) {
    return rejected(named.error);
  }

  const parent = cellAt(document, parentId);
  const referenceIndex = parent.children.indexOf(referenceId);
  const insertionIndex = referenceIndex + (position === "after" ? 1 : 0);
  const children = [...parent.children];
  children.splice(insertionIndex, 0, named.cell.id);
  return {
    ok: true,
    document: {
      rootId: document.rootId,
      cells: {
        ...document.cells,
        [parentId]: { ...parent, children },
        [named.cell.id]: named.cell,
      },
    },
  };
}

export function update(
  document: NotebookDocument,
  cellId: CellId,
  patch: CellPatch,
): CommandResult {
  const malformed = invalidDocument(document);
  if (malformed !== undefined) {
    return malformed;
  }
  if (!hasCell(document, cellId)) {
    return rejected(
      commandError(
        "CELL_NOT_FOUND",
        `Cell ${JSON.stringify(cellId)} does not exist.`,
        cellId,
      ),
    );
  }
  if (!isPlainRecord(patch)) {
    return rejected(
      commandError("INVALID_PATCH", "Cell patch must be an object.", cellId),
    );
  }

  const patchKeys = Object.keys(patch);
  if (
    patchKeys.length === 0 ||
    patchKeys.some((key) => !Object.hasOwn(CELL_PATCH_KEYS, key))
  ) {
    return rejected(
      commandError(
        "INVALID_PATCH",
        "Cell patch must contain only mutable cell data fields.",
        cellId,
      ),
    );
  }

  if (
    Object.hasOwn(patch, "kind") &&
    (typeof patch.kind !== "string" ||
      !Object.hasOwn(VALID_KINDS, patch.kind))
  ) {
    return rejected(
      commandError("INVALID_PATCH", "Cell kind is invalid.", cellId),
    );
  }
  if (Object.hasOwn(patch, "source") && typeof patch.source !== "string") {
    return rejected(
      commandError("INVALID_PATCH", "Cell source must be a string.", cellId),
    );
  }
  if (
    Object.hasOwn(patch, "classes") &&
    (!Array.isArray(patch.classes) ||
      !patch.classes.every((className) => typeof className === "string"))
  ) {
    return rejected(
      commandError(
        "INVALID_PATCH",
        "Cell classes must be an array of strings.",
        cellId,
      ),
    );
  }
  if (
    Object.hasOwn(patch, "metadata") &&
    (!isPlainRecord(patch.metadata) ||
      !isSerializableValue(patch.metadata))
  ) {
    return rejected(
      commandError(
        "INVALID_PATCH",
        "Cell metadata must be a serializable object.",
        cellId,
      ),
    );
  }

  if (Object.hasOwn(patch, "name")) {
    if (typeof patch.name !== "string") {
      return rejected(
        commandError(
          "INVALID_NAME",
          "Cell name must be a JavaScript identifier.",
          cellId,
        ),
      );
    }
    const validation = validateCellName(patch.name);
    if (!validation.valid) {
      return rejected(
        commandError(
          validation.problem === "reserved" ? "RESERVED_NAME" : "INVALID_NAME",
          validation.problem === "reserved"
            ? `Cell name ${JSON.stringify(patch.name)} is reserved by notebook handles.`
            : `Cell name ${JSON.stringify(patch.name)} is not a JavaScript identifier.`,
          cellId,
        ),
      );
    }

    const parentId = findParentId(document, cellId);
    if (
      parentId !== undefined &&
      nameSetForChildren(document, parentId, cellId).has(patch.name)
    ) {
      return rejected(
        commandError(
          "NAME_CONFLICT",
          `Sibling name ${JSON.stringify(patch.name)} is already in use.`,
          cellId,
        ),
      );
    }
  }

  const current = cellAt(document, cellId);
  const next: Cell = {
    ...current,
    ...(Object.hasOwn(patch, "kind") ? { kind: patch.kind as CellKind } : {}),
    ...(Object.hasOwn(patch, "name") ? { name: patch.name as string } : {}),
    ...(Object.hasOwn(patch, "source")
      ? { source: patch.source as string }
      : {}),
    ...(Object.hasOwn(patch, "classes")
      ? { classes: [...(patch.classes as readonly string[])] }
      : {}),
    ...(Object.hasOwn(patch, "metadata")
      ? {
          metadata: cloneSerializableValue(patch.metadata) as Record<
            string,
            unknown
          >,
        }
      : {}),
  };

  return {
    ok: true,
    document: {
      rootId: document.rootId,
      cells: { ...document.cells, [cellId]: next },
    },
  };
}

export function move(
  document: NotebookDocument,
  cellId: CellId,
  target: MoveTarget,
): CommandResult {
  const malformed = invalidDocument(document);
  if (malformed !== undefined) {
    return malformed;
  }
  if (!hasCell(document, cellId)) {
    return rejected(
      commandError(
        "CELL_NOT_FOUND",
        `Cell ${JSON.stringify(cellId)} does not exist.`,
        cellId,
      ),
    );
  }
  if (cellId === document.rootId) {
    return rejected(
      commandError("ROOT_PROTECTED", "The root cell cannot be moved.", cellId),
    );
  }

  const sourceParentId = findParentId(document, cellId);
  if (sourceParentId === undefined) {
    return rejected(
      commandError("PARENT_NOT_FOUND", "Moving cell has no parent.", cellId),
    );
  }
  const subtreeIds = collectSubtreeIds(document, cellId);
  const destination = resolveMoveDestination(
    document,
    cellId,
    sourceParentId,
    target,
    subtreeIds,
  );
  if (!destination.ok) {
    return rejected(destination.error);
  }

  const movingCell = cellAt(document, cellId);
  if (
    destination.parentId !== sourceParentId &&
    movingCell.name !== undefined &&
    nameSetForChildren(document, destination.parentId).has(movingCell.name)
  ) {
    return rejected(
      commandError(
        "NAME_CONFLICT",
        `Destination already has a child named ${JSON.stringify(movingCell.name)}.`,
        cellId,
        destination.parentId,
      ),
    );
  }

  const sourceParent = cellAt(document, sourceParentId);
  const destinationParent = cellAt(document, destination.parentId);
  const destinationChildren = destinationParent.children.filter(
    (childId) => childId !== cellId,
  );
  destinationChildren.splice(destination.insertionIndex, 0, cellId);

  const cells = { ...document.cells };
  if (sourceParentId === destination.parentId) {
    cells[sourceParentId] = {
      ...sourceParent,
      children: destinationChildren,
    };
  } else {
    cells[sourceParentId] = {
      ...sourceParent,
      children: sourceParent.children.filter((childId) => childId !== cellId),
    };
    cells[destination.parentId] = {
      ...destinationParent,
      children: destinationChildren,
    };
  }

  return {
    ok: true,
    document: { rootId: document.rootId, cells },
  };
}

export function remove(
  document: NotebookDocument,
  cellId: CellId,
): CommandResult {
  const malformed = invalidDocument(document);
  if (malformed !== undefined) {
    return malformed;
  }
  if (!hasCell(document, cellId)) {
    return rejected(
      commandError(
        "CELL_NOT_FOUND",
        `Cell ${JSON.stringify(cellId)} does not exist.`,
        cellId,
      ),
    );
  }
  if (cellId === document.rootId) {
    return rejected(
      commandError("ROOT_PROTECTED", "The root cell cannot be removed.", cellId),
    );
  }

  const parentId = findParentId(document, cellId);
  if (parentId === undefined) {
    return rejected(
      commandError("PARENT_NOT_FOUND", "Removed cell has no parent.", cellId),
    );
  }

  const removedIds = collectSubtreeIds(document, cellId);
  const cells = { ...document.cells };
  for (const removedId of removedIds) {
    delete cells[removedId];
  }
  const parent = cellAt(document, parentId);
  cells[parentId] = {
    ...parent,
    children: parent.children.filter((childId) => childId !== cellId),
  };

  return {
    ok: true,
    document: { rootId: document.rootId, cells },
  };
}

export function parentOf(
  document: NotebookDocument,
  cellId: CellId,
): ParentLookupResult {
  const validation = validateNotebook(document);
  if (!validation.valid) {
    return {
      ok: false,
      error: {
        code: "INVALID_DOCUMENT",
        message: "Notebook document is malformed.",
        diagnostics: validation.diagnostics,
      },
    };
  }
  if (!hasCell(document, cellId)) {
    return {
      ok: false,
      error: commandError(
        "CELL_NOT_FOUND",
        `Cell ${JSON.stringify(cellId)} does not exist.`,
        cellId,
      ),
    };
  }
  return {
    ok: true,
    parentId:
      cellId === document.rootId ? undefined : findParentId(document, cellId),
  };
}
