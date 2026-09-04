import { describe, expect, it } from "vitest";
import { TINY_COMMERCE_IDS, TINY_COMMERCE_NOTEBOOK } from "../demo/notebook";
import { formatValue } from "./format-value";
import { breadcrumbsFor } from "./tree-helpers";

describe("notebook UI helpers", () => {
  it("derives breadcrumbs from normalized structure", () => {
    expect(
      breadcrumbsFor(TINY_COMMERCE_NOTEBOOK, TINY_COMMERCE_IDS.metrics),
    ).toEqual([
      { id: TINY_COMMERCE_IDS.root, label: "tinyCommerce" },
      { id: TINY_COMMERCE_IDS.analysis, label: "analysis" },
      { id: TINY_COMMERCE_IDS.metrics, label: "metrics" },
    ]);
    expect(breadcrumbsFor(TINY_COMMERCE_NOTEBOOK, "missing")).toEqual([]);
  });

  it("formats awkward JavaScript values without throwing", () => {
    const circular: Record<string, unknown> = {
      missing: undefined,
      large: 12n,
      callback: function calculate() {},
    };
    circular.self = circular;

    expect(formatValue(circular)).toContain("missing: undefined");
    expect(formatValue(circular)).toContain("large: 12n");
    expect(formatValue(circular)).toContain("[Function calculate]");
    expect(formatValue(circular)).toContain("self: [Circular]");

    const throwing = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("no access");
      },
    });
    expect(() => formatValue(throwing)).not.toThrow();
    expect(formatValue(throwing)).toContain("[Thrown while reading]");
  });
});
