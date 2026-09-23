import { describe, expect, it } from "vitest";
import type { Cell, CellId, CellKind, NotebookDocument } from "../model/types";
import type { PreparedNotebook } from "../compiler/protocol";
import {
  IMPORTS_UNSUPPORTED_ERROR,
  INVALID_TYPESCRIPT_ERROR,
  TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR,
  prepareExecution,
} from "../compiler/fast-prepare";
import {
  ASYNC_RESULT_ERROR,
  executeNotebookTransaction,
} from "./execute";
import type { CellRuntimeRegistry } from "./registry";
import { createRuntimeRegistry } from "./registry";

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

function execute(
  document: NotebookDocument,
  registry: CellRuntimeRegistry,
  changedIds?: Iterable<CellId>,
) {
  const prepared = prepareExecution(document);
  return changedIds
    ? executeNotebookTransaction(document, registry, { prepared, changedIds })
    : executeNotebookTransaction(document, registry, { prepared });
}

describe("notebook transactions", () => {
  it("executes a Tiny Commerce chain through direct and explicit paths and reruns only affected cells", () => {
    const products = cell(
      "products",
      "javascript",
      '[{ name: "Lamp", price: 10, region: "eu" }]',
    );
    const regions = cell(
      "regions",
      "javascript",
      '({ eu: { tax: 0.2, currency: "EUR" } })',
    );
    const data = cell("data", "text", "Data", ["products", "regions"]);
    const pricedProducts = cell(
      "pricedProducts",
      "javascript",
      `root.data.products.value.map((item) => ({
          ...item,
          finalPrice: item.price * (1 + root.children.data.children.regions.value[item.region].tax),
          currency: root.children.data.children.regions.value[item.region].currency,
        }))`,
    );
    const metrics = cell(
      "metrics",
      "javascript",
      "({ count: parent.pricedProducts.value.length, total: parent.pricedProducts.value.reduce((sum, item) => sum + item.finalPrice, 0) })",
    );
    const analysis = cell("analysis", "text", "Analysis", ["pricedProducts", "metrics"]);
    const dashboard = cell(
      "dashboard",
      "markdown",
      "md`# ${root.data.products.value.length}:${root.analysis.metrics.value.total}`",
    );
    const unrelated = cell(
      "unrelated",
      "javascript",
      "({ stable: true })",
    );
    const root = cell(
      "root",
      "text",
      "Tiny Commerce",
      ["data", "analysis", "dashboard", "unrelated"],
    );
    const document: NotebookDocument = {
      rootId: "root",
      cells: {
        root,
        data,
        products,
        regions,
        analysis,
        pricedProducts,
        metrics,
        dashboard,
        unrelated,
      },
    };
    const serialized = JSON.stringify(document);
    const registry = createRuntimeRegistry();

    const first = execute(document, registry);
    expect(first.executedIds).toEqual([
      "products",
      "regions",
      "unrelated",
      "pricedProducts",
      "metrics",
      "dashboard",
    ]);
    expect(registry.get("pricedProducts")?.peek()).toEqual([
      {
        name: "Lamp",
        price: 10,
        region: "eu",
        finalPrice: 12,
        currency: "EUR",
      },
    ]);
    expect(registry.get("metrics")?.peek()).toEqual({ count: 1, total: 12 });
    expect(registry.get("dashboard")?.peek()).toBe("# 1:12");
    const unrelatedValue = registry.get("unrelated")?.peek();
    expect(JSON.stringify(document)).toBe(serialized);

    const updatedProducts = cell(
      "products",
      "javascript",
      '[{ name: "Lamp", price: 20, region: "eu" }]',
    );
    const updated: NotebookDocument = {
      ...document,
      cells: { ...document.cells, products: updatedProducts },
    };
    const second = execute(updated, registry, ["products"]);

    expect(second.affectedIds).toEqual([
      "products",
      "pricedProducts",
      "metrics",
      "dashboard",
    ]);
    expect(second.executedIds).toEqual(second.affectedIds);
    expect(registry.get("dashboard")?.peek()).toBe("# 1:24");
    expect(registry.get("products")?.version()).toBe(2);
    expect(registry.get("pricedProducts")?.version()).toBe(2);
    expect(registry.get("metrics")?.version()).toBe(2);
    expect(registry.get("dashboard")?.version()).toBe(2);
    expect(registry.get("regions")?.version()).toBe(1);
    expect(registry.get("unrelated")?.version()).toBe(1);
    expect(registry.get("unrelated")?.peek()).toBe(unrelatedValue);
  });

  it("publishes upstream values before downstream execution and continues unrelated branches after an error", () => {
    const document = flatDocument([
      cell("upstream", "javascript", "4"),
      cell(
        "downstream",
        "javascript",
        "root.upstream.value + 3",
      ),
      cell(
        "broken",
        "javascript",
        '(() => { throw new Error("broken branch") })()',
      ),
      cell("independent", "javascript", "9"),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("upstream")?.peek()).toBe(4);
    expect(registry.get("downstream")?.peek()).toBe(7);
    expect(registry.get("broken")?.status()).toBe("error");
    expect(registry.get("broken")?.error()).toBe("broken branch");
    expect(registry.get("independent")?.status()).toBe("success");
    expect(registry.get("independent")?.peek()).toBe(9);
  });

  it("rejects invalid TypeScript, imports, and top-level await without running those cells", () => {
    const document = flatDocument([
      cell("syntax", "javascript", "const value: = 1"),
      cell(
        "imported",
        "javascript",
        'import "unavailable"; 1',
      ),
      cell(
        "awaited",
        "javascript",
        "await Promise.resolve()",
      ),
      cell("valid", "javascript", "2"),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("syntax")?.error()).toBe(INVALID_TYPESCRIPT_ERROR);
    expect(registry.get("imported")?.error()).toBe(IMPORTS_UNSUPPORTED_ERROR);
    expect(registry.get("awaited")?.error()).toBe(
      TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR,
    );
    expect(registry.get("valid")?.peek()).toBe(2);
  });

  it("publishes direct expressions and parenthesized object literals", () => {
    const document = flatDocument([
      cell("answer", "javascript", "42"),
      cell("record", "javascript", "({ answer: root.answer.value })"),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("answer")?.peek()).toBe(42);
    expect(registry.get("record")?.peek()).toEqual({ answer: 42 });
  });

  it("executes expressions and Markdown with semicolons or trailing comments", () => {
    const document = flatDocument([
      cell("input", "javascript", "41; // the answer is next"),
      cell("sum", "javascript", "parent.input.value + 1; // stays reactive"),
      cell("report", "markdown", "md`# ${parent.sum.value}`; // summary"),
    ]);
    const registry = createRuntimeRegistry();
    expect(execute(document, registry).executedIds).toEqual(["input", "sum", "report"]);
    expect(registry.get("sum")?.peek()).toBe(42);
    expect(registry.get("report")?.peek()).toBe("# 42");
    expect(execute({ ...document, cells: { ...document.cells, input: { ...document.cells.input!, source: "10 // edited" } } }, registry, ["input"]).executedIds).toEqual(["input", "sum", "report"]);
    expect(registry.get("report")?.peek()).toBe("# 11");
  });

  it("rejects old callback cell sources without invoking them", () => {
    const document = flatDocument([
      cell("oldCode", "javascript", "$(() => 7)"),
      cell("oldMarkdown", "markdown", "md(() => '# old')"),
    ]);
    const registry = createRuntimeRegistry();
    execute(document, registry);
    expect(registry.get("oldCode")?.status()).toBe("error");
    expect(registry.get("oldCode")?.error()).toContain("Callback helpers are not supported");
    expect(registry.get("oldMarkdown")?.status()).toBe("error");
  });

  it("exports top-level bindings and evaluates implicit handles in code and tagged Markdown", () => {
    const document = flatDocument([
      cell("budget", "javascript", "const nightly = 18000; const nights = 3; const total = nightly * nights"),
      cell("extra", "javascript", "const { total: base } = parent.budget.value; function withTax(rate: number) { return base * (1 + rate) }; const taxed = withTax(0.25)"),
      cell("report", "markdown", "md`# Trip\\n\\n${parent.extra.value.taxed} yen (${root.budget.value.nights} nights)`"),
    ]);
    const registry = createRuntimeRegistry();
    const first = execute(document, registry);
    expect(first.executedIds).toEqual(["budget", "extra", "report"]);
    expect(registry.get("budget")?.peek()).toEqual({ nightly: 18000, nights: 3, total: 54000 });
    expect((registry.get("extra")?.peek() as { taxed: number }).taxed).toBe(67500);
    expect(registry.get("report")?.peek()).toBe("# Trip\n\n67500 yen (3 nights)");

    const changed: NotebookDocument = {
      ...document,
      cells: { ...document.cells, budget: { ...document.cells.budget!, source: "const nightly = 20000; const nights = 3; const total = nightly * nights" } },
    };
    const second = execute(changed, registry, ["budget"]);
    expect(second.executedIds).toEqual(["budget", "extra", "report"]);
    expect((registry.get("extra")?.peek() as { taxed: number }).taxed).toBe(75000);
    expect(registry.get("report")?.peek()).toContain("75000");
  });

  it("publishes a standalone expression instead of an empty export object", () => {
    const document = flatDocument([
      cell("calmRiver", "javascript", 'const value = "Hi"; const b = 235; const c = "hi"'),
      cell("brightCloud", "javascript", "parent.calmRiver.value.c"),
      cell("report", "markdown", "md`# ${parent.brightCloud.value}`"),
    ]);
    const registry = createRuntimeRegistry();
    expect(execute(document, registry).executedIds).toEqual(["calmRiver", "brightCloud", "report"]);
    expect(registry.get("brightCloud")?.peek()).toBe("hi");
    expect(registry.get("report")?.peek()).toBe("# hi");
  });

  it("publishes the bindings of top-level declaration cells", () => {
    const document = flatDocument([
      cell("mixed", "javascript", 'const value = 42; const label = "answer"'),
    ]);
    const registry = createRuntimeRegistry();
    execute(document, registry);
    expect(registry.get("mixed")?.peek()).toEqual({ value: 42, label: "answer" });
  });

  it("rejects promises and thenables", () => {
    const document = flatDocument([
      cell("promise", "javascript", "Promise.resolve(1)"),
      cell(
        "thenable",
        "javascript",
        "({ then(resolve) { resolve(1) } })",
      ),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("promise")?.error()).toBe(ASYNC_RESULT_ERROR);
    expect(registry.get("thenable")?.error()).toBe(ASYNC_RESULT_ERROR);
  });

  it("publishes strings from tagged Markdown cells", () => {
    const document = flatDocument([
      cell("title", "text", "Commerce"),
      cell(
        "markdown",
        "markdown",
        "md`# ${root.title.value}`",
      ),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("title")?.peek()).toBe("Commerce");
    expect(registry.get("markdown")?.peek()).toBe("# Commerce");
    expect(registry.get("markdown")?.status()).toBe("success");
  });

  it("marks cycle members, self-cycles, and cycle-blocked dependents without blocking independent work", () => {
    const document = flatDocument([
      cell("a", "javascript", "root.b.value"),
      cell("b", "javascript", "root.a.value"),
      cell("after", "javascript", "root.a.value + 1"),
      cell("selfCycle", "javascript", "self.value"),
      cell("independent", "javascript", "5"),
    ]);
    const registry = createRuntimeRegistry();

    const result = execute(document, registry);

    expect(result.graph.cycleGroups).toEqual([
      { cellIds: ["a", "b"] },
      { cellIds: ["selfCycle"] },
    ]);
    expect(result.graph.blockedByCycles).toEqual(["after"]);
    for (const cellId of ["a", "b", "after", "selfCycle"]) {
      expect(registry.get(cellId)?.status()).toBe("cycle");
      expect(registry.get(cellId)?.error()).toBe("Reactive dependency cycle");
      expect(registry.get(cellId)?.version()).toBe(1);
    }
    expect(registry.get("independent")?.peek()).toBe(5);
  });

  it("consumes prepared output or an explicitly injected notebook preparer", () => {
    const preparedDocument = flatDocument([
      cell("prepared", "javascript", "1"),
    ]);
    const baseline = prepareExecution(preparedDocument);
    const prepared: PreparedNotebook = {
      ...baseline,
      cells: baseline.cells.map((entry) =>
        entry.cellId === "prepared" && entry.ok
          ? { ...entry, code: "return (7);" }
          : entry,
      ),
    };
    const preparedRegistry = createRuntimeRegistry();
    executeNotebookTransaction(preparedDocument, preparedRegistry, { prepared });
    expect(preparedRegistry.get("prepared")?.peek()).toBe(7);

    const preparedByFunctionRegistry = createRuntimeRegistry();
    executeNotebookTransaction(preparedDocument, preparedByFunctionRegistry, {
      prepare: () => ({
        ...prepared,
        cells: prepared.cells.map((entry) =>
          entry.cellId === "prepared" && entry.ok
            ? { ...entry, code: "return (11);" }
            : entry,
        ),
      }),
    });
    expect(preparedByFunctionRegistry.get("prepared")?.peek()).toBe(11);
  });

  it("keeps Function execution explicitly unsandboxed and preserves function results", () => {
    const document = flatDocument([
      cell(
        "realm",
        "javascript",
        "globalThis.Math === Math && globalThis.Array === Array",
      ),
      cell("functionValue", "javascript", "Math.max"),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("realm")?.peek()).toBe(true);
    expect(registry.get("functionValue")?.peek()).toBe(Math.max);
  });
});
