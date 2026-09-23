import { describe, expect, it } from "vitest";
import { proseProgram, splitProse } from "./prose-structure";

const TRIP = [
  "Kyoto in November. Three nights, two of us.",
  "",
  "Stay at a machiya near Nishiki, about 18000 yen a night.",
  "",
  "I want a number before I book.",
].join("\n");

describe("prose structure", () => {
  it("keeps a mid-paragraph cursor split verbatim", () => {
    const at = TRIP.indexOf("Three");
    expect(splitProse(TRIP, at)).toEqual({
      before: "Kyoto in November. ",
      after: "Three nights, two of us.\n\nStay at a machiya near Nishiki, about 18000 yen a night.\n\nI want a number before I book.",
    });
  });

  it("gives the following paragraph to the new cell when the cursor is in the gap", () => {
    const gap = TRIP.indexOf("\n\nStay");
    const expected = {
      before: "Kyoto in November. Three nights, two of us.",
      after: "Stay at a machiya near Nishiki, about 18000 yen a night.\n\nI want a number before I book.",
    };
    expect(splitProse(TRIP, gap)).toEqual(expected);
    expect(splitProse(TRIP, gap + 1)).toEqual(expected);
    expect(splitProse(TRIP, gap + 2)).toEqual(expected);
  });

  it("splits at the document edges without inventing text", () => {
    expect(splitProse(TRIP, 0)).toEqual({ before: "", after: TRIP });
    expect(splitProse(TRIP, TRIP.length)).toEqual({ before: TRIP, after: "" });
    expect(splitProse("one line", 4)).toEqual({ before: "one ", after: "line" });
  });

  it("turns prose into a quoted program instead of a zero placeholder", () => {
    expect(proseProgram("javascript", "  18000 yen a night  ")).toBe(
      '$(() => "18000 yen a night")',
    );
    expect(proseProgram("markdown", "Friday — arrive")).toBe(
      'md(() => "Friday — arrive")',
    );
    expect(proseProgram("javascript", " \n ")).toBe("$(() => 0)");
    expect(proseProgram("markdown", "")).toBe('md(() => "")');
    expect(proseProgram("javascript", 'say "hi"\nthen go')).toBe(
      '$(() => "say \\"hi\\"\\nthen go")',
    );
  });
});
