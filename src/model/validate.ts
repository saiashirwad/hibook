import { validateCellName } from "./names";
import type {
  CellId,
  CellKind,
  ValidationDiagnostic,
  ValidationErrorCode,
  ValidationResult,
} from "./types";

const VALID_KINDS: Record<CellKind, true> = {
  text: true,
  javascript: true,
  markdown: true,
};

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isSerializableValue(
  value: unknown,
  ancestors: ReadonlySet<object> = new Set<object>(),
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return false;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    return value.every((item) => isSerializableValue(item, nextAncestors));
  }

  if (!isPlainRecord(value)) {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  return Object.values(value).every((item) =>
    isSerializableValue(item, nextAncestors),
  );
}

function makeDiagnostic(
  code: ValidationErrorCode,
  path: string,
  message: string,
  cellId?: CellId,
  relatedCellId?: CellId,
): ValidationDiagnostic {
  return {
    code,
    path,
    message,
    ...(cellId === undefined ? {} : { cellId }),
    ...(relatedCellId === undefined ? {} : { relatedCellId }),
  };
}

function validateNotebookUnchecked(snapshot: unknown): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];

  if (!isPlainRecord(snapshot)) {
    return {
      valid: false,
      diagnostics: [
        makeDiagnostic(
          "DOCUMENT_NOT_OBJECT",
          "$",
          "Notebook document must be an object.",
        ),
      ],
    };
  }

  const rootId = snapshot.rootId;
  const cellsValue = snapshot.cells;

  if (typeof rootId !== "string" || rootId.length === 0) {
    diagnostics.push(
      makeDiagnostic(
        "ROOT_ID_MISSING",
        "rootId",
        "Notebook rootId must be a non-empty string.",
      ),
    );
  }

  if (!isPlainRecord(cellsValue)) {
    diagnostics.push(
      makeDiagnostic(
        "CELLS_MISSING",
        "cells",
        "Notebook cells must be an object keyed by cell ID.",
      ),
    );
    return { valid: false, diagnostics };
  }

  const cellKeys = Object.keys(cellsValue);
  const keySet = new Set(cellKeys);
  const childrenByParent = new Map<CellId, CellId[]>();
  const parentsByChild = new Map<CellId, Set<CellId>>();
  const keysByDeclaredId = new Map<CellId, CellId[]>();
  const namesByKey = new Map<CellId, string>();

  for (const key of cellKeys) {
    const path = `cells.${key}`;
    const value = cellsValue[key];
    if (!isPlainRecord(value)) {
      diagnostics.push(
        makeDiagnostic(
          "CELL_NOT_OBJECT",
          path,
          "Cell entry must be an object.",
          key,
        ),
      );
      continue;
    }

    const id = value.id;
    if (typeof id !== "string" || id.length === 0) {
      diagnostics.push(
        makeDiagnostic(
          "CELL_ID_INVALID",
          `${path}.id`,
          "Cell id must be a non-empty string.",
          key,
        ),
      );
    } else {
      const declaredKeys = keysByDeclaredId.get(id) ?? [];
      declaredKeys.push(key);
      keysByDeclaredId.set(id, declaredKeys);
      if (id !== key) {
        diagnostics.push(
          makeDiagnostic(
            "CELL_KEY_MISMATCH",
            `${path}.id`,
            `Cell id ${JSON.stringify(id)} does not match key ${JSON.stringify(key)}.`,
            key,
            id,
          ),
        );
      }
      if (key === rootId && id !== rootId) {
        diagnostics.push(
          makeDiagnostic(
            "ROOT_CELL_ID_MISMATCH",
            `${path}.id`,
            "The root cell id must match rootId and its cells key.",
            key,
            id,
          ),
        );
      }
    }

    const kind = value.kind;
    if (typeof kind !== "string" || !Object.hasOwn(VALID_KINDS, kind)) {
      diagnostics.push(
        makeDiagnostic(
          "CELL_KIND_INVALID",
          `${path}.kind`,
          "Cell kind must be text, javascript, or markdown.",
          key,
        ),
      );
    }

    if (typeof value.source !== "string") {
      diagnostics.push(
        makeDiagnostic(
          "CELL_SOURCE_INVALID",
          `${path}.source`,
          "Cell source must be a string.",
          key,
        ),
      );
    }

    if (
      !Array.isArray(value.classes) ||
      !value.classes.every((className) => typeof className === "string")
    ) {
      diagnostics.push(
        makeDiagnostic(
          "CELL_CLASSES_INVALID",
          `${path}.classes`,
          "Cell classes must be an array of strings.",
          key,
        ),
      );
    }

    if (!isPlainRecord(value.metadata)) {
      diagnostics.push(
        makeDiagnostic(
          "CELL_METADATA_INVALID",
          `${path}.metadata`,
          "Cell metadata must be an object.",
          key,
        ),
      );
    } else if (!isSerializableValue(value.metadata)) {
      diagnostics.push(
        makeDiagnostic(
          "CELL_METADATA_NOT_SERIALIZABLE",
          `${path}.metadata`,
          "Cell metadata must contain only finite JSON-compatible values.",
          key,
        ),
      );
    }

    if (Object.hasOwn(value, "name")) {
      if (typeof value.name !== "string") {
        diagnostics.push(
          makeDiagnostic(
            "CELL_NAME_INVALID",
            `${path}.name`,
            "Cell name must be a JavaScript identifier.",
            key,
          ),
        );
      } else {
        namesByKey.set(key, value.name);
        const nameValidation = validateCellName(value.name);
        if (!nameValidation.valid) {
          diagnostics.push(
            makeDiagnostic(
              nameValidation.problem === "reserved"
                ? "CELL_NAME_RESERVED"
                : "CELL_NAME_INVALID",
              `${path}.name`,
              nameValidation.problem === "reserved"
                ? `Cell name ${JSON.stringify(value.name)} is reserved by notebook handles.`
                : `Cell name ${JSON.stringify(value.name)} is not a JavaScript identifier.`,
              key,
            ),
          );
        }
      }
    }

    const children = value.children;
    if (!Array.isArray(children)) {
      diagnostics.push(
        makeDiagnostic(
          "CELL_CHILDREN_INVALID",
          `${path}.children`,
          "Cell children must be an array of cell IDs.",
          key,
        ),
      );
      continue;
    }

    const validChildren: CellId[] = [];
    const childIdsSeen = new Set<CellId>();
    children.forEach((childId, index) => {
      if (typeof childId !== "string" || childId.length === 0) {
        diagnostics.push(
          makeDiagnostic(
            "CHILD_ID_INVALID",
            `${path}.children.${index}`,
            "Child ID must be a non-empty string.",
            key,
          ),
        );
        return;
      }

      validChildren.push(childId);
      if (childIdsSeen.has(childId)) {
        diagnostics.push(
          makeDiagnostic(
            "DUPLICATE_CHILD",
            `${path}.children.${index}`,
            `Child ${JSON.stringify(childId)} occurs more than once under the same parent.`,
            key,
            childId,
          ),
        );
      }
      childIdsSeen.add(childId);

      const parents = parentsByChild.get(childId) ?? new Set<CellId>();
      parents.add(key);
      parentsByChild.set(childId, parents);

      if (!keySet.has(childId)) {
        diagnostics.push(
          makeDiagnostic(
            "DANGLING_CHILD",
            `${path}.children.${index}`,
            `Child ${JSON.stringify(childId)} has no cells entry.`,
            key,
            childId,
          ),
        );
      }
    });
    childrenByParent.set(key, validChildren);
  }

  for (const [declaredId, keys] of keysByDeclaredId) {
    if (keys.length > 1) {
      for (const key of keys) {
        diagnostics.push(
          makeDiagnostic(
            "DUPLICATE_CELL_ID",
            `cells.${key}.id`,
            `Cell id ${JSON.stringify(declaredId)} is declared by multiple entries.`,
            key,
            declaredId,
          ),
        );
      }
    }
  }

  if (typeof rootId === "string" && rootId.length > 0) {
    if (!keySet.has(rootId)) {
      diagnostics.push(
        makeDiagnostic(
          "ROOT_NOT_FOUND",
          "rootId",
          `Root ${JSON.stringify(rootId)} has no cells entry.`,
          rootId,
        ),
      );
    }

    const rootParents = parentsByChild.get(rootId);
    if (rootParents !== undefined && rootParents.size > 0) {
      diagnostics.push(
        makeDiagnostic(
          "ROOT_HAS_PARENT",
          "rootId",
          "The root cell cannot be a child of another cell.",
          rootId,
          rootParents.values().next().value,
        ),
      );
    }
  }

  for (const [childId, parents] of parentsByChild) {
    if (keySet.has(childId) && parents.size > 1) {
      const [firstParent, secondParent] = parents;
      diagnostics.push(
        makeDiagnostic(
          "MULTIPLE_PARENTS",
          `cells.${childId}`,
          `Cell ${JSON.stringify(childId)} has more than one parent.`,
          childId,
          secondParent ?? firstParent,
        ),
      );
    }
  }

  for (const children of childrenByParent.values()) {
    const childByName = new Map<string, CellId>();
    for (const childId of new Set(children)) {
      const name = namesByKey.get(childId);
      if (name === undefined) {
        continue;
      }
      const priorChildId = childByName.get(name);
      if (priorChildId !== undefined) {
        diagnostics.push(
          makeDiagnostic(
            "SIBLING_NAME_CONFLICT",
            `cells.${childId}.name`,
            `Sibling name ${JSON.stringify(name)} is already used by ${JSON.stringify(priorChildId)}.`,
            childId,
            priorChildId,
          ),
        );
      } else {
        childByName.set(name, childId);
      }
    }
  }

  const reachable = new Set<CellId>();
  if (typeof rootId === "string" && keySet.has(rootId)) {
    const pending = [rootId];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || reachable.has(current)) {
        continue;
      }
      reachable.add(current);
      for (const childId of childrenByParent.get(current) ?? []) {
        if (keySet.has(childId) && !reachable.has(childId)) {
          pending.push(childId);
        }
      }
    }
  }

  for (const key of cellKeys) {
    if (!reachable.has(key)) {
      diagnostics.push(
        makeDiagnostic(
          "UNREACHABLE_CELL",
          `cells.${key}`,
          `Cell ${JSON.stringify(key)} is not reachable from the root.`,
          key,
        ),
      );
    }
  }

  const visitState = new Map<CellId, "visiting" | "visited">();
  const reportedCycleEdges = new Set<string>();
  const visit = (cellId: CellId): void => {
    visitState.set(cellId, "visiting");
    for (const childId of childrenByParent.get(cellId) ?? []) {
      if (!keySet.has(childId)) {
        continue;
      }
      if (visitState.get(childId) === "visiting") {
        const edge = `${cellId}\u0000${childId}`;
        if (!reportedCycleEdges.has(edge)) {
          reportedCycleEdges.add(edge);
          diagnostics.push(
            makeDiagnostic(
              "CYCLE",
              `cells.${cellId}.children`,
              `Child edge from ${JSON.stringify(cellId)} to ${JSON.stringify(childId)} creates a cycle.`,
              cellId,
              childId,
            ),
          );
        }
      } else if (visitState.get(childId) !== "visited") {
        visit(childId);
      }
    }
    visitState.set(cellId, "visited");
  };

  for (const key of cellKeys) {
    if (visitState.get(key) === undefined) {
      visit(key);
    }
  }

  return diagnostics.length === 0
    ? { valid: true, diagnostics: [] }
    : { valid: false, diagnostics };
}

export function validateNotebook(snapshot: unknown): ValidationResult {
  try {
    return validateNotebookUnchecked(snapshot);
  } catch {
    return {
      valid: false,
      diagnostics: [
        makeDiagnostic(
          "VALIDATION_EXCEPTION",
          "$",
          "Notebook snapshot could not be inspected safely.",
        ),
      ],
    };
  }
}
