import { describe, expect, it } from "vitest";
import type { Cell, CellId, CellKind, NotebookDocument } from "../model/types";
import { FastPreparationCore } from "./fast-prepare";
import {
  ContentAwareVfs,
  SemanticProjectCore,
} from "./semantic-core";
import type { SemanticCellResult } from "./semantic-protocol";

function cell(
  id: CellId,
  kind: CellKind,
  source: string,
  children: readonly CellId[] = [],
): Cell {
  return {
    id,
    name: id,
    kind,
    source,
    classes: [],
    metadata: {},
    children: [...children],
  };
}

function document(cells: readonly Cell[]): NotebookDocument {
  const entries = cells.map((entry) => [entry.id, entry] as const);
  return { rootId: cells[0]?.id ?? "root", cells: Object.fromEntries(entries) };
}

function semanticCell(
  cells: readonly SemanticCellResult[],
  cellId: CellId,
): SemanticCellResult {
  const result = cells.find((entry) => entry.cellId === cellId);
  if (!result) throw new Error(`Missing semantic result for ${cellId}`);
  return result;
}

function inputFor(documentValue: NotebookDocument) {
  return {
    document: documentValue,
    prepared: new FastPreparationCore().prepare(documentValue),
  };
}

describe("semantic notebook project", () => {
  it("infers standalone expression and binding-cell types", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["amount", "budget"]),
      cell("amount", "javascript", "42"),
      cell("budget", "javascript", "const nightly = 18000; const nights = 3; const total = nightly * nights"),
    ]);
    const result = new SemanticProjectCore().infer(inputFor(notebook));

    expect(semanticCell(result.cells, "root")).toMatchObject({
      authoritative: true,
      status: "text",
      type: "string",
    });
    expect(semanticCell(result.cells, "amount")).toMatchObject({
      authoritative: true,
      status: "inferred",
      type: "42",
    });
    expect(semanticCell(result.cells, "budget")).toMatchObject({
      authoritative: true,
      status: "inferred",
    });
    expect(semanticCell(result.cells, "budget").type).toContain("nightly: number");
    expect(semanticCell(result.cells, "budget").type).toContain("total: number");
    expect(result.timings.counters).toMatchObject({
      layers: 1,
      programBuilds: 1,
      reusedCells: 0,
    });
    expect(() => structuredClone(result)).not.toThrow();
  });

  it("keeps browser globals available in the locally bundled standard library", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["browser"]),
      cell(
        "browser",
        "javascript",
        'typeof document.title === "string" && typeof window.location.href === "string" && typeof setTimeout === "function" && typeof fetch === "function"',
      ),
    ]);
    const result = semanticCell(
      new SemanticProjectCore().infer(inputFor(notebook)).cells,
      "browser",
    );

    expect(result).toMatchObject({
      status: "inferred",
      type: "boolean",
      diagnostics: [],
    });
  });

  it("infers in topological layers so downstream cells see the printed upstream type", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["products", "count"]),
      cell(
        "products",
        "javascript",
        '([{ sku: "lamp", price: 42 }])',
      ),
      cell(
        "count",
        "javascript",
        "root.products.value.reduce((sum, product) => sum + product.price, 0)",
      ),
    ]);
    const result = new SemanticProjectCore().infer(inputFor(notebook));

    expect(semanticCell(result.cells, "products").type).toContain("price: number");
    expect(semanticCell(result.cells, "count")).toMatchObject({
      status: "inferred",
      type: "number",
    });
    expect(result.timings.counters.layers).toBe(2);
    expect(result.timings.counters.programBuilds).toBe(2);
  });

  it("infers exported bindings through implicit handles and offers their completions in Markdown", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["budget", "report"]),
      cell("budget", "javascript", "const nightly = 18000; const nights = 3; const total = nightly * nights"),
      cell("report", "markdown", "md`Total: ${parent.budget.value.total.toFixed(0)}`"),
    ]);
    const core = new SemanticProjectCore();
    const input = inputFor(notebook);
    const result = core.infer(input);
    expect(semanticCell(result.cells, "budget")).toMatchObject({ status: "inferred", diagnostics: [] });
    expect(semanticCell(result.cells, "budget").type).toContain("total: number");
    expect(semanticCell(result.cells, "report")).toMatchObject({ status: "inferred", type: "string", diagnostics: [] });
    const source = notebook.cells.report!.source;
    const completion = core.completions(input, "report", source.indexOf(".total") + 1).completion;
    expect(completion.items.map((item) => item.label)).toContain("total");
  });

  it("infers standalone expression values and diagnoses child-handle access without .value", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["calmRiver", "brightCloud", "incorrect"]),
      cell("calmRiver", "javascript", 'const value = "Hi"; const c = "hi"'),
      cell("brightCloud", "javascript", "parent.calmRiver.value.c"),
      cell("incorrect", "javascript", "parent.calmRiver.c"),
    ]);
    const result = new SemanticProjectCore().infer(inputFor(notebook));
    expect(semanticCell(result.cells, "brightCloud")).toMatchObject({
      status: "inferred", type: "string", diagnostics: [],
    });
    expect(semanticCell(result.cells, "incorrect").diagnostics.some(
      (diagnostic) => diagnostic.message.includes("Property 'c' does not exist"),
    )).toBe(true);
  });

  it("infers expressions and Markdown despite trailing semicolons and comments", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["input", "output"]),
      cell("input", "javascript", "40 + 2; // answer"),
      cell("output", "markdown", "md`# ${parent.input.value}`; // summary"),
    ]);
    const result = new SemanticProjectCore().infer(inputFor(notebook));
    expect(semanticCell(result.cells, "input")).toMatchObject({ status: "inferred", type: "number", diagnostics: [] });
    expect(semanticCell(result.cells, "output")).toMatchObject({ status: "inferred", type: "string", diagnostics: [] });
  });

  it("writes a whole ready layer before one shared Program build", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["left", "right"]),
      cell("left", "javascript", '({ side: "left" as const })'),
      cell("right", "javascript", '({ side: "right" as const })'),
    ]);
    const result = new SemanticProjectCore().infer(inputFor(notebook));

    expect(semanticCell(result.cells, "left").type).toContain('side: "left"');
    expect(semanticCell(result.cells, "right").type).toContain('side: "right"');
    expect(result.timings.counters).toMatchObject({
      layers: 1,
      programBuilds: 1,
    });
  });

  it("isolates invalid and cyclic cells while unrelated inference survives", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["broken", "first", "second", "safe"]),
      cell("broken", "javascript", "const value: = 1"),
      cell("first", "javascript", "root.second.value"),
      cell("second", "javascript", "root.first.value"),
      cell("safe", "javascript", "({ healthy: true })"),
    ]);
    const result = new SemanticProjectCore().infer(inputFor(notebook));

    expect(semanticCell(result.cells, "broken")).toMatchObject({
      status: "invalid",
      type: "unknown",
    });
    expect(semanticCell(result.cells, "first")).toMatchObject({
      status: "cycle",
      type: "unknown",
    });
    expect(semanticCell(result.cells, "second")).toMatchObject({
      status: "cycle",
      type: "unknown",
    });
    expect(semanticCell(result.cells, "safe")).toMatchObject({
      status: "inferred",
    });
    expect(semanticCell(result.cells, "safe").type).toContain("healthy: boolean");
  });

  it("reuses prior results only outside the source-change downstream closure", () => {
    const initial = document([
      cell("root", "text", "Notebook", ["input", "derived", "unrelated"]),
      cell("input", "javascript", "1"),
      cell("derived", "javascript", "root.input.value + 1"),
      cell("unrelated", "javascript", '({ branch: "stable" })'),
    ]);
    const core = new SemanticProjectCore();
    core.infer(inputFor(initial));
    const changed = document([
      initial.cells.root!,
      cell("input", "javascript", "2"),
      initial.cells.derived!,
      initial.cells.unrelated!,
    ]);
    const result = core.infer({
      ...inputFor(changed),
      changedCellIds: ["input"],
    });

    expect(semanticCell(result.cells, "derived").type).toBe("number");
    expect(result.timings.counters.reusedCells).toBe(2);
    expect(result.timings.counters.programBuilds).toBe(2);
    expect(result.timings.counters.vfsSkips).toBeGreaterThan(0);
  });

  it("counts byte-identical VFS writes as skips without changing versions", () => {
    const vfs = new ContentAwareVfs();

    expect(vfs.write("/cell-a.ts", "const a = 1")).toBe(true);
    const version = vfs.version("/cell-a.ts");
    expect(vfs.write("/cell-a.ts", "const a = 1")).toBe(false);
    expect(vfs.version("/cell-a.ts")).toBe(version);
    expect(vfs.counters()).toEqual({ writes: 1, skips: 1 });
  });

  it("maps completion, diagnostics, and quick info back to cell source offsets", () => {
    const completionNotebook = document([
      cell("root", "text", "Notebook", ["products", "editor"]),
      cell("products", "javascript", "({ price: 42 })"),
      cell("editor", "javascript", "root.", ["nested"]),
      cell("nested", "text", "Nested"),
    ]);
    const completionCore = new SemanticProjectCore();
    const completionSource = completionNotebook.cells.editor!.source;
    const completion = completionCore.completions(
      inputFor(completionNotebook),
      "editor",
      completionSource.indexOf("root.") + "root.".length,
    ).completion;
    expect(completion.items.map((item) => item.label)).toContain("products");
    expect(completion.from).toBe(completion.to);
    expect(completion.from).toBe(completionSource.indexOf("root.") + "root.".length);

    const parentNotebook = document([
      cell("root", "text", "Notebook", ["products", "editor"]),
      cell("products", "javascript", "({ price: 42 })"),
      cell("editor", "javascript", "parent."),
    ]);
    const parentSource = parentNotebook.cells.editor!.source;
    const parentCompletion = new SemanticProjectCore().completions(
      inputFor(parentNotebook),
      "editor",
      parentSource.indexOf("parent.") + "parent.".length,
    ).completion;
    expect(parentCompletion.items.map((item) => item.label)).toContain("products");

    const selfNotebook = document([
      cell("root", "text", "Notebook", ["editor"]),
      cell("editor", "javascript", "self.", ["nested"]),
      cell("nested", "text", "Nested"),
    ]);
    const selfSource = selfNotebook.cells.editor!.source;
    const selfCompletion = new SemanticProjectCore().completions(
      inputFor(selfNotebook),
      "editor",
      selfSource.indexOf("self.") + "self.".length,
    ).completion;
    expect(selfCompletion.items.map((item) => item.label)).toContain("nested");

    const toolingNotebook = document([
      cell("root", "text", "Notebook", ["products", "consumer"]),
      cell("products", "javascript", "({ price: 42 })"),
      cell(
        "consumer",
        "javascript",
        "root.products.value.missing",
      ),
    ]);
    const toolingCore = new SemanticProjectCore();
    const toolingSource = toolingNotebook.cells.consumer!.source;
    const input = inputFor(toolingNotebook);
    const diagnostics = toolingCore.diagnostics(input, "consumer").diagnostics;
    expect(diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.from === toolingSource.indexOf("missing"))).toBe(true);

    const quickInfoPosition = toolingSource.indexOf("products") + 2;
    const quickInfo = toolingCore.quickInfo(
      input,
      "consumer",
      quickInfoPosition,
    ).quickInfo;
    expect(quickInfo).toMatchObject({
      from: toolingSource.indexOf("products"),
      to: toolingSource.indexOf("products") + "products".length,
    });
    expect(quickInfo?.parts.map((part) => part.text).join("")).toContain("products");
  });

  it("types Markdown contexts readonly and reports attempted handle writes", () => {
    const notebook = document([
      cell("root", "text", "Notebook", ["report"]),
      cell(
        "report",
        "markdown",
        'md`${(root.value = "changed", "# Report")}`',
      ),
    ]);
    const source = notebook.cells.report!.source;
    const diagnostics = new SemanticProjectCore().diagnostics(
      inputFor(notebook),
      "report",
    ).diagnostics;

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.from === source.indexOf("value") &&
          diagnostic.message.includes("read-only"),
      ),
    ).toBe(true);
  });
});
