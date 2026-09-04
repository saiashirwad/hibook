import { describe, expect, it } from "vitest";
import { revisionForDocument } from "../compiler/protocol";
import { TINY_COMMERCE_IDS, TINY_COMMERCE_NOTEBOOK } from "./notebook";

describe("Tiny Commerce notebook", () => {
  it("keeps deterministic IDs, names, order, and revision input", () => {
    expect(TINY_COMMERCE_NOTEBOOK.rootId).toBe(TINY_COMMERCE_IDS.root);
    expect(Object.keys(TINY_COMMERCE_NOTEBOOK.cells)).toEqual(
      Object.values(TINY_COMMERCE_IDS),
    );
    expect(
      Object.values(TINY_COMMERCE_NOTEBOOK.cells).map((cell) => cell.name),
    ).toEqual([
      "tinyCommerce",
      "introduction",
      "data",
      "products",
      "regions",
      "analysis",
      "pricedProducts",
      "metrics",
      "report",
      "unrelated",
      "branchVersion",
    ]);
    expect(TINY_COMMERCE_NOTEBOOK.cells[TINY_COMMERCE_IDS.root]?.children).toEqual([
      TINY_COMMERCE_IDS.intro,
      TINY_COMMERCE_IDS.data,
      TINY_COMMERCE_IDS.analysis,
      TINY_COMMERCE_IDS.report,
      TINY_COMMERCE_IDS.unrelated,
    ]);
    expect(revisionForDocument(TINY_COMMERCE_NOTEBOOK)).toBe(
      JSON.stringify(TINY_COMMERCE_NOTEBOOK),
    );
  });

  it("uses direct, explicit children, and expected-parent paths", () => {
    expect(
      TINY_COMMERCE_NOTEBOOK.cells[TINY_COMMERCE_IDS.pricedProducts]?.source,
    ).toContain("root.data.products.value");
    expect(
      TINY_COMMERCE_NOTEBOOK.cells[TINY_COMMERCE_IDS.pricedProducts]?.source,
    ).toContain("root.children.data.children.regions.value");
    expect(TINY_COMMERCE_NOTEBOOK.cells[TINY_COMMERCE_IDS.metrics]?.source).toContain(
      "parent.pricedProducts.value",
    );
    expect(TINY_COMMERCE_NOTEBOOK.cells[TINY_COMMERCE_IDS.report]?.source).toContain(
      "root.analysis.metrics.value",
    );
  });
});
