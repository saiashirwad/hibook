import { describe, expect, it } from "vitest";
import type { Cell, CellId, CellKind, NotebookDocument } from "../model/types";
import {
  FastPreparationCore,
  IMPORTS_UNSUPPORTED_ERROR,
  INVALID_TYPESCRIPT_ERROR,
  MODULE_SYNTAX_UNSUPPORTED_ERROR,
  TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR,
  prepareExecution,
} from "./fast-prepare";
import type { PreparedNotebook } from "./protocol";
import { revisionForDocument } from "./protocol";

function cell(
  id: CellId,
  kind: CellKind,
  source: string,
  children: CellId[] = [],
  name: string = id,
): Cell {
  return {
    id,
    name,
    kind,
    source,
    classes: [],
    metadata: {},
    children,
  };
}

function flatDocument(cells: readonly Cell[]): NotebookDocument {
  const root = cell(
    "root",
    "text",
    "Notebook",
    cells.map((entry) => entry.id),
  );
  return {
    rootId: root.id,
    cells: Object.fromEntries([root, ...cells].map((entry) => [entry.id, entry])),
  };
}

function preparedCell(
  document: NotebookDocument,
  cellId: CellId,
) {
  const prepared = prepareExecution(document).cells.find(
    (entry) => entry.cellId === cellId,
  );
  if (!prepared) {
    throw new Error(`Expected prepared cell: ${cellId}`);
  }
  return prepared;
}

describe("fast notebook preparation", () => {
  it("uses exact deterministic serialization as the revision", () => {
    const document = flatDocument([
      cell("value", "javascript", "$(() => 1)"),
    ]);

    expect(revisionForDocument(document)).toBe(JSON.stringify(document));
    expect(revisionForDocument(document)).toBe(revisionForDocument(document));
    expect(
      revisionForDocument({
        ...document,
        cells: {
          ...document.cells,
          value: { ...document.cells.value!, source: "$(() => 2)" },
        },
      }),
    ).not.toBe(revisionForDocument(document));
  });

  it("returns serializable cells, graph data, provisional types, dependencies, and real timing counters", () => {
    const input = cell("input", "javascript", "$(() => 2)");
    const calculated = cell(
      "calculated",
      "javascript",
      "$(({ root }) => root.section.input.value + root.children.section.children.input.value)",
    );
    const explicit = cell("explicit", "javascript", "$<number>(() => 3)");
    const invalid = cell("invalid", "javascript", "$(() => {");
    const firstCycle = cell(
      "firstCycle",
      "javascript",
      "$<string>(({ root }) => root.section.secondCycle.value)",
    );
    const secondCycle = cell(
      "secondCycle",
      "javascript",
      "$(({ root }) => root.section.firstCycle.value)",
    );
    const section = cell("section", "text", "Section", [
      "input",
      "calculated",
      "explicit",
      "invalid",
      "firstCycle",
      "secondCycle",
    ]);
    const root = cell("root", "text", "Notebook", ["section"]);
    const document: NotebookDocument = {
      rootId: "root",
      cells: {
        root,
        section,
        input,
        calculated,
        explicit,
        invalid,
        firstCycle,
        secondCycle,
      },
    };

    const prepared = prepareExecution(document);
    expect(prepared.revision).toBe(JSON.stringify(document));
    expect(preparedCell(document, "root")).toMatchObject({
      ok: true,
      type: "string",
      status: "text",
      code: "",
    });
    expect(
      prepared.cells.find((entry) => entry.cellId === "calculated"),
    ).toMatchObject({
      ok: true,
      dependencies: ["input"],
      status: "inferred",
      type: "unknown",
    });
    expect(
      prepared.cells.find((entry) => entry.cellId === "explicit"),
    ).toMatchObject({ ok: true, status: "explicit", type: "number" });
    expect(
      prepared.cells.find((entry) => entry.cellId === "invalid"),
    ).toMatchObject({
      ok: false,
      status: "invalid",
      type: "unknown",
      issues: [{ code: "SYNTAX_ERROR" }],
      error: {
        code: "INVALID_TYPESCRIPT",
        message: INVALID_TYPESCRIPT_ERROR,
      },
    });
    for (const cellId of ["firstCycle", "secondCycle"]) {
      expect(prepared.cells.find((entry) => entry.cellId === cellId)).toMatchObject(
        { ok: true, status: "cycle", type: "unknown" },
      );
    }
    expect(prepared.graph.cycleGroups).toEqual([
      ["firstCycle", "secondCycle"],
    ]);
    expect(prepared.graph.cycleMembers).toEqual([
      "firstCycle",
      "secondCycle",
    ]);
    expect(prepared.graph.order).toEqual(Object.keys(document.cells));
    expect(prepared.timings).toMatchObject({
      cellCount: 8,
      reusedCells: 0,
      transpiledCells: 5,
    });
    for (const measured of [
      prepared.timings.totalMs,
      prepared.timings.analysisMs,
      prepared.timings.transpileMs,
    ]) {
      expect(Number.isFinite(measured)).toBe(true);
      expect(measured).toBeGreaterThanOrEqual(0);
    }
    expect(() => structuredClone(prepared)).not.toThrow();
  });

  it("preserves the existing syntax and unsupported-module errors", () => {
    const cases = [
      ["$(() => {", "INVALID_TYPESCRIPT", INVALID_TYPESCRIPT_ERROR],
      [
        'import value from "package"; $(() => value)',
        "IMPORT_UNSUPPORTED",
        IMPORTS_UNSUPPORTED_ERROR,
      ],
      [
        "export const value = 1; $(() => value)",
        "MODULE_SYNTAX_UNSUPPORTED",
        MODULE_SYNTAX_UNSUPPORTED_ERROR,
      ],
      [
        "await Promise.resolve(); $(() => 1)",
        "TOP_LEVEL_AWAIT_UNSUPPORTED",
        TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR,
      ],
    ] as const;

    for (const [source, code, message] of cases) {
      expect(
        preparedCell(
          flatDocument([cell("code", "javascript", source)]),
          "code",
        ),
      ).toMatchObject({ ok: false, error: { code, message } });
    }
  });

  it("reuses only byte-identical transpiled code while reanalyzing structural paths", () => {
    const inputA = cell("inputA", "javascript", "$(() => 1)", [], "input");
    const inputB = cell("inputB", "javascript", "$(() => 2)", [], "input");
    const derived = cell(
      "derived",
      "javascript",
      "$(({ parent }) => parent.input.value)",
    );
    const groupA = cell("groupA", "text", "A", ["inputA", "derived"]);
    const groupB = cell("groupB", "text", "B", ["inputB"]);
    const root = cell("root", "text", "Notebook", ["groupA", "groupB"]);
    const firstDocument: NotebookDocument = {
      rootId: "root",
      cells: { root, groupA, inputA, derived, groupB, inputB },
    };
    const core = new FastPreparationCore();
    const first = core.prepare(firstDocument);
    const firstDerived = first.cells.find((entry) => entry.cellId === "derived");
    expect(firstDerived).toMatchObject({ dependencies: ["inputA"] });

    const secondDocument: NotebookDocument = {
      ...firstDocument,
      cells: {
        ...firstDocument.cells,
        groupA: { ...groupA, children: ["inputA"] },
        groupB: { ...groupB, children: ["inputB", "derived"] },
      },
    };
    const second = core.prepare(secondDocument);
    const secondDerived = second.cells.find((entry) => entry.cellId === "derived");
    expect(secondDerived).toMatchObject({ dependencies: ["inputB"] });
    expect(secondDerived?.ok && secondDerived.code).toBe(
      firstDerived?.ok && firstDerived.code,
    );
    expect(second.timings.reusedCells).toBe(3);
    expect(second.timings.transpiledCells).toBe(0);
  });

  it("reuses dependency analyses for cells whose source and structure are unchanged", () => {
    const count = cell("count", "javascript", "$(() => 1)");
    const derived = cell(
      "derived",
      "javascript",
      "$(({ root }) => root.count.value)",
    );
    const document = flatDocument([count, derived]);
    const core = new FastPreparationCore();
    const analysisFor = (prepared: PreparedNotebook, cellId: CellId) =>
      prepared.cells.find((entry) => entry.cellId === cellId)?.analysis;

    const first = core.prepare(document);
    const edited = core.prepare({
      ...document,
      cells: {
        ...document.cells,
        count: { ...count, source: "$(() => 2)" },
      },
    });
    expect(analysisFor(edited, "derived")).toBe(analysisFor(first, "derived"));
    expect(analysisFor(edited, "count")).not.toBe(analysisFor(first, "count"));

    const renamed = core.prepare({
      ...document,
      cells: {
        ...document.cells,
        count: { ...count, source: "$(() => 2)", name: "renamed" },
      },
    });
    expect(analysisFor(renamed, "derived")).not.toBe(
      analysisFor(edited, "derived"),
    );
    expect(analysisFor(renamed, "derived")?.dependencies).not.toEqual(
      analysisFor(edited, "derived")?.dependencies,
    );
  });
});
