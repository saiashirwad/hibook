import { describe, expect, it } from "vitest";
import {
  generateCellName,
  isValidCellName,
  validateCellName,
} from "./names";

describe("cell names", () => {
  it("accepts JavaScript identifiers used by direct member paths", () => {
    expect(isValidCellName("productsBySku")).toBe(true);
    expect(isValidCellName("_private")).toBe(true);
    expect(isValidCellName("$result")).toBe(true);
    expect(isValidCellName("café")).toBe(true);
    expect(isValidCellName("商品")).toBe(true);
    expect(isValidCellName("await")).toBe(true);
  });

  it("rejects non-identifiers and every reserved handle field", () => {
    expect(validateCellName("two words")).toEqual({
      valid: false,
      problem: "invalid",
    });
    expect(validateCellName("1stCell")).toEqual({
      valid: false,
      problem: "invalid",
    });

    for (const reserved of [
      "value",
      "children",
      "id",
      "name",
      "kind",
      "text",
      "update",
      "append",
      "remove",
      "replaceChildren",
    ]) {
      expect(validateCellName(reserved)).toEqual({
        valid: false,
        problem: "reserved",
      });
    }
  });

  it("probes readable candidates and suffixes after exhausting the base list", () => {
    expect(generateCellName(new Set(["amberCloud"]), () => 0)).toBe(
      "amberFern",
    );

    const allBaseNames = new Set<string>();
    for (let sample = 0; sample < 64; sample += 1) {
      allBaseNames.add(generateCellName(new Set(), () => sample / 64));
    }
    expect(generateCellName(allBaseNames, () => 0)).toBe("amberCloud2");
  });
});
