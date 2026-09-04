import { describe, expect, it } from "vitest";
import type { Cell, CellKind, NotebookDocument } from "../model/types";
import { analyzeCellDependencies } from "./analyze-dependencies";

function cell(
  id: string,
  name: string,
  kind: CellKind = "text",
  source = id,
  children: string[] = [],
): Cell {
  return { id, name, kind, source, classes: [], metadata: {}, children };
}

function document(source: string, kind: CellKind = "javascript"): NotebookDocument {
  return {
    rootId: "root-id",
    cells: {
      "root-id": cell(
        "root-id",
        "notebook",
        "text",
        "Notebook",
        ["data-id", "group-id"],
      ),
      "data-id": cell("data-id", "data", "text", "Data", ["products-id"]),
      "products-id": cell("products-id", "products"),
      "group-id": cell(
        "group-id",
        "group",
        "text",
        "Group",
        ["input-id", "calc-id"],
      ),
      "input-id": cell("input-id", "input"),
      "calc-id": cell(
        "calc-id",
        "calc",
        kind,
        source,
        ["local-id"],
      ),
      "local-id": cell("local-id", "local"),
    },
  };
}

function analysis(source: string, kind: CellKind = "javascript") {
  const notebook = document(source, kind);
  const analyzed = notebook.cells["calc-id"];
  if (!analyzed) {
    throw new Error("fixture is missing calc-id");
  }
  return { notebook, result: analyzeCellDependencies(notebook, analyzed) };
}

describe("TypeScript dependency analysis", () => {
  it("extracts mixed paths, stable IDs, source spans, annotations, and de-duplicates reads", () => {
    const source = `$<ReadonlyArray< Product >>(({ root, parent, self }) => {
  const direct = root.data.products.value;
  const explicit = root.children.data.children.products.value;
  const mixed = root.data.children.products.value;
  const sibling = parent.input.value;
  const descendant = self.local.value;
  const duplicate = root.data.products.value;
  return [direct, explicit, mixed, sibling, descendant, duplicate];
})`;
    const { notebook, result } = analysis(source);

    expect(result.dependencies).toEqual([
      "products-id",
      "input-id",
      "local-id",
    ]);
    expect(result.references).toHaveLength(6);
    expect(result.annotation).toEqual({
      text: "ReadonlyArray< Product >",
      span: {
        start: source.indexOf("ReadonlyArray"),
        end: source.indexOf("ReadonlyArray") + "ReadonlyArray< Product >".length,
      },
    });
    const direct = result.references[0];
    expect(direct).toMatchObject({
      path: {
        origin: { kind: "root" },
        hops: [
          { kind: "child", name: "data" },
          { kind: "child", name: "products" },
        ],
      },
      resolution: { status: "resolved", targetId: "products-id" },
    });
    expect(
      source.slice(direct?.path.span.start, direct?.path.span.end),
    ).toBe("root.data.products.value");
    expect(result.references[1]?.path.hops.map((hop) => hop.kind)).toEqual([
      "children",
      "child",
      "children",
      "child",
    ]);
    expect(result.references[2]?.path.hops.map((hop) => hop.kind)).toEqual([
      "child",
      "children",
      "child",
    ]);
    expect(notebook.cells["calc-id"]?.source).toBe(source);
  });

  it("reports missing, invalid, and computed paths without false edges", () => {
    const source = `$(({ root }) => {
  const key = "products";
  return [
    root.missing.value,
    root.children.value,
    root.data[key].value,
  ];
})`;
    const { result } = analysis(source);

    expect(result.dependencies).toEqual([]);
    expect(result.issues.map(({ code }) => code)).toEqual([
      "MISSING_TARGET",
      "INVALID_PATH",
      "DYNAMIC_PATH",
    ]);
    expect(result.references.map(({ resolution }) => resolution.status)).toEqual([
      "missing",
      "invalid",
      "dynamic",
    ]);
    const dynamic = result.issues[2];
    expect(source.slice(dynamic?.span.start, dynamic?.span.end)).toBe("key");
  });

  it("respects lexical shadowing inside nested functions and blocks", () => {
    const source = `$(({ root, parent }) => {
  const product = root.data.products.value;
  function nested(root: { fake: { value: number } }) {
    return root.fake.value;
  }
  {
    const parent = { fake: { value: 1 } };
    parent.fake.value;
  }
  for (const root of [{ fake: { value: 1 } }]) {
    root.fake.value;
  }
  switch (1) {
    case 1:
      const root = { fake: { value: 1 } };
      root.fake.value;
      break;
    default:
      root.fake.value;
  }
  return product + nested({ fake: { value: 1 } });
})`;
    const { result } = analysis(source);

    expect(result.dependencies).toEqual(["products-id"]);
    expect(result.references).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it("does not classify scalar handle metadata or its value chains as aliases", () => {
    const { result } = analysis(`$(({ root }) => {
  const name = root.name;
  const id = root.data.id;
  const kind = root.data.kind;
  const textLength = root.data.text.length;
  const nameValue = root.name.value;
  return [name, id, kind, textLength, nameValue];
})`);

    expect(result.dependencies).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("ignores reads beyond a runtime value while retaining the true dependency", () => {
    const { result } = analysis(`$(({ root }) => {
  const nested = root.data.products.value.value;
  return nested;
})`);

    expect(result.dependencies).toEqual(["products-id"]);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]?.resolution).toEqual({
      status: "resolved",
      targetId: "products-id",
    });
    expect(result.issues).toEqual([]);
  });

  it("reports callback and local handle aliases instead of guessing their targets", () => {
    const callbackAlias = analysis(
      `$(({ root: notebookRoot }) => notebookRoot.data.products.value)`,
    ).result;
    expect(callbackAlias.dependencies).toEqual([]);
    expect(callbackAlias.issues).toMatchObject([
      { classification: "aliased", code: "ALIASED_CONTEXT" },
    ]);

    const localAlias = analysis(`$(({ root }) => {
  const products = root.data.products;
  const children = root.children;
  return [products.value, children];
})`).result;
    expect(localAlias.dependencies).toEqual([]);
    expect(localAlias.issues).toMatchObject([
      { classification: "aliased", code: "ALIASED_CONTEXT" },
      { classification: "aliased", code: "ALIASED_CONTEXT" },
    ]);
  });

  it("keeps syntax failures local with stable offsets", () => {
    const source = `$(({ root }) => {
  return root.data.products.value;
`;
    const { result } = analysis(source);

    expect(result.dependencies).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.issues[0]).toMatchObject({
      classification: "syntax",
      code: "SYNTAX_ERROR",
    });
    expect(result.issues[0]?.span.start).toBeGreaterThanOrEqual(0);
    expect(result.issues[0]?.span.end).toBeLessThanOrEqual(source.length);
  });

  it("extracts dependencies from Markdown callbacks without executing them", () => {
    const { result } = analysis(
      "md(({ root }) => `# ${root.data.products.value}`)",
      "markdown",
    );

    expect(result.dependencies).toEqual(["products-id"]);
    expect(result.references).toHaveLength(1);
    expect(result.issues).toEqual([]);
    expect(result.annotation).toBeUndefined();
  });

  it("treats text cells as non-executable even when their prose resembles code", () => {
    const { notebook } = analysis("ignored");
    const text = cell(
      "text-id",
      "prose",
      "text",
      "root.data.products.value",
    );
    const result = analyzeCellDependencies(
      {
        ...notebook,
        cells: { ...notebook.cells, "text-id": text },
      },
      text,
    );

    expect(result).toEqual({
      cellId: "text-id",
      kind: "text",
      dependencies: [],
      references: [],
      issues: [],
    });
  });
});
