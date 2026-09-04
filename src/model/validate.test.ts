import { describe, expect, it } from "vitest";
import type { Cell, NotebookDocument, ValidationErrorCode } from "./types";
import { validateNotebook } from "./validate";

function makeCell(
  id: string,
  name: string,
  children: string[] = [],
): Cell {
  return {
    id,
    kind: "text",
    name,
    source: "",
    classes: [],
    metadata: {},
    children,
  };
}

function diagnosticCodes(snapshot: unknown): Set<ValidationErrorCode> {
  const result = validateNotebook(snapshot);
  expect(result.valid).toBe(false);
  return new Set(result.diagnostics.map((diagnostic) => diagnostic.code));
}

describe("validateNotebook", () => {
  it("accepts a normalized tree with sibling-scoped names", () => {
    const document: NotebookDocument = {
      rootId: "root",
      cells: {
        root: makeCell("root", "reused", ["left", "right"]),
        left: makeCell("left", "left", ["leftNested"]),
        leftNested: makeCell("leftNested", "reused"),
        right: makeCell("right", "right", ["rightNested"]),
        rightNested: makeCell("rightNested", "reused"),
      },
    };

    expect(validateNotebook(document)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("reports missing document fields without throwing", () => {
    expect(diagnosticCodes({})).toEqual(
      new Set(["ROOT_ID_MISSING", "CELLS_MISSING"]),
    );
    expect(diagnosticCodes(null)).toEqual(new Set(["DOCUMENT_NOT_OBJECT"]));
  });

  it("reports structural, identity, reachability, cycle, and naming defects together", () => {
    const malformed = {
      rootId: "root",
      cells: {
        root: {
          ...makeCell("wrongRootId", "notebook"),
          children: ["a", "a", "c", "missing", "shared"],
        },
        a: makeCell("a", "duplicateName", ["root"]),
        c: makeCell("a", "duplicateName"),
        shared: makeCell("shared", "children"),
        detached: makeCell("detached", "two words", ["shared"]),
      },
    };

    const codes = diagnosticCodes(malformed);
    expect(codes).toEqual(
      new Set([
        "ROOT_CELL_ID_MISMATCH",
        "CELL_KEY_MISMATCH",
        "DUPLICATE_CELL_ID",
        "CELL_NAME_RESERVED",
        "CELL_NAME_INVALID",
        "DUPLICATE_CHILD",
        "DANGLING_CHILD",
        "ROOT_HAS_PARENT",
        "MULTIPLE_PARENTS",
        "SIBLING_NAME_CONFLICT",
        "UNREACHABLE_CELL",
        "CYCLE",
      ]),
    );
  });

  it("distinguishes a missing root and malformed cell fields", () => {
    const codes = diagnosticCodes({
      rootId: "missingRoot",
      cells: {
        cell: {
          id: "",
          kind: "sql",
          source: 42,
          classes: ["valid", 7],
          metadata: [],
          children: [null],
        },
      },
    });

    expect(codes).toEqual(
      new Set([
        "ROOT_NOT_FOUND",
        "CELL_ID_INVALID",
        "CELL_KIND_INVALID",
        "CELL_SOURCE_INVALID",
        "CELL_CLASSES_INVALID",
        "CELL_METADATA_INVALID",
        "CHILD_ID_INVALID",
        "UNREACHABLE_CELL",
      ]),
    );
  });

  it("rejects non-serializable metadata", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const document = {
      rootId: "root",
      cells: {
        root: {
          ...makeCell("root", "notebook"),
          metadata: {
            circular,
            functionValue: () => "not persisted",
          },
        },
      },
    };

    expect(diagnosticCodes(document)).toEqual(
      new Set(["CELL_METADATA_NOT_SERIALIZABLE"]),
    );
  });

  it("converts hostile property access into a structured diagnostic", () => {
    const snapshot = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
      },
    );

    expect(validateNotebook(snapshot)).toEqual({
      valid: false,
      diagnostics: [
        {
          code: "VALIDATION_EXCEPTION",
          path: "$",
          message: "Notebook snapshot could not be inspected safely.",
        },
      ],
    });
  });
});
