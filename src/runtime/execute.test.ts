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
  CALLBACK_REQUIRED_ERROR,
  MARKDOWN_RESULT_ERROR,
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
      '$(() => [{ name: "Lamp", price: 10, region: "eu" }])',
    );
    const regions = cell(
      "regions",
      "javascript",
      '$(() => ({ eu: { tax: 0.2, currency: "EUR" } }))',
    );
    const data = cell("data", "text", "Data", ["products", "regions"]);
    const pricedProducts = cell(
      "pricedProducts",
      "javascript",
      `$(({ root }) => {
        const items = root.data.products.value
        const configuration = root.children.data.children.regions.value
        return items.map((item) => ({
          ...item,
          finalPrice: item.price * (1 + configuration[item.region].tax),
          currency: configuration[item.region].currency,
        }))
      })`,
    );
    const metrics = cell(
      "metrics",
      "javascript",
      `$(({ parent }) => {
        const items = parent.pricedProducts.value
        return { count: items.length, total: items.reduce((sum, item) => sum + item.finalPrice, 0) }
      })`,
    );
    const analysis = cell("analysis", "text", "Analysis", ["pricedProducts", "metrics"]);
    const dashboard = cell(
      "dashboard",
      "markdown",
      "md(({ root }) => `# ${root.data.products.value.length}:${root.analysis.metrics.value.total}`)",
    );
    const unrelated = cell(
      "unrelated",
      "javascript",
      "$(() => ({ stable: true }))",
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
      '$(() => [{ name: "Lamp", price: 20, region: "eu" }])',
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
      cell("upstream", "javascript", "$(() => 4)"),
      cell(
        "downstream",
        "javascript",
        "$(({ root }) => root.upstream.value + 3)",
      ),
      cell(
        "broken",
        "javascript",
        '$(() => { throw new Error("broken branch") })',
      ),
      cell("independent", "javascript", "$(() => 9)"),
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
      cell("syntax", "javascript", "$(() => {"),
      cell(
        "imported",
        "javascript",
        'import "unavailable"; $(() => 1)',
      ),
      cell(
        "awaited",
        "javascript",
        "await Promise.resolve(); $(() => 1)",
      ),
      cell("valid", "javascript", "$(() => 2)"),
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

  it("enforces one callback-only API invocation", () => {
    const document = flatDocument([
      cell("missing", "javascript", "const value = 1"),
      cell("multiple", "javascript", "$(() => 1); $(() => 2)"),
      cell("nonCallback", "javascript", "$(42)"),
      cell("extraArgument", "javascript", "$(() => 1, 2)"),
      cell("wrongHelper", "javascript", "md(() => 1)"),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    for (const cellId of [
      "missing",
      "multiple",
      "nonCallback",
      "extraArgument",
      "wrongHelper",
    ]) {
      expect(registry.get(cellId)?.status()).toBe("error");
      expect(registry.get(cellId)?.error()).toBe(CALLBACK_REQUIRED_ERROR);
    }
  });

  it("rejects promises and thenables", () => {
    const document = flatDocument([
      cell("promise", "javascript", "$(() => Promise.resolve(1))"),
      cell(
        "thenable",
        "javascript",
        "$(() => ({ then(resolve) { resolve(1) } }))",
      ),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("promise")?.error()).toBe(ASYNC_RESULT_ERROR);
    expect(registry.get("thenable")?.error()).toBe(ASYNC_RESULT_ERROR);
  });

  it("publishes Markdown strings and rejects non-string Markdown results", () => {
    const document = flatDocument([
      cell("title", "text", "Commerce"),
      cell(
        "markdown",
        "markdown",
        "md(({ root }) => `# ${root.title.value}`)",
      ),
      cell("invalidMarkdown", "markdown", "md(() => ({ value: 1 }))"),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("title")?.peek()).toBe("Commerce");
    expect(registry.get("markdown")?.peek()).toBe("# Commerce");
    expect(registry.get("markdown")?.status()).toBe("success");
    expect(registry.get("invalidMarkdown")?.error()).toBe(
      MARKDOWN_RESULT_ERROR,
    );
  });

  it("marks cycle members, self-cycles, and cycle-blocked dependents without blocking independent work", () => {
    const document = flatDocument([
      cell("a", "javascript", "$(({ root }) => root.b.value)"),
      cell("b", "javascript", "$(({ root }) => root.a.value)"),
      cell("after", "javascript", "$(({ root }) => root.a.value + 1)"),
      cell("selfCycle", "javascript", "$(({ self }) => self.value)"),
      cell("independent", "javascript", "$(() => 5)"),
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
      cell("prepared", "javascript", "$<number>(() => 1)"),
    ]);
    const baseline = prepareExecution(preparedDocument);
    const prepared: PreparedNotebook = {
      ...baseline,
      cells: baseline.cells.map((entry) =>
        entry.cellId === "prepared" && entry.ok
          ? { ...entry, code: "$(() => 7);" }
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
            ? { ...entry, code: "$(() => 11);" }
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
        "$(() => globalThis.Math === Math && globalThis.Array === Array)",
      ),
      cell("functionValue", "javascript", "$(() => Math.max)"),
    ]);
    const registry = createRuntimeRegistry();

    execute(document, registry);

    expect(registry.get("realm")?.peek()).toBe(true);
    expect(registry.get("functionValue")?.peek()).toBe(Math.max);
  });
});
