import { describe, expect, it } from "vitest";
import type { Cell, CellKind, NotebookDocument } from "../model/types";
import { buildNotebookDependencyGraph } from "./dependency-graph";
import {
  IMPORTS_UNSUPPORTED_ERROR,
  INVALID_TYPESCRIPT_ERROR,
  MODULE_SYNTAX_UNSUPPORTED_ERROR,
  TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR,
  prepareCellSynchronously,
} from "./prepare";

function cell(id: string, kind: CellKind, source: string): Cell {
  return {
    id,
    name: id,
    kind,
    source,
    classes: [],
    metadata: {},
    children: [],
  };
}

function prepare(source: string) {
  const executable = cell("code", "javascript", source);
  const document: NotebookDocument = {
    rootId: "code",
    cells: { code: executable },
  };
  const analysis = buildNotebookDependencyGraph(document).analyses.get("code");
  if (!analysis) {
    throw new Error("Expected dependency analysis");
  }
  return {
    analysis,
    result: prepareCellSynchronously(document, executable, analysis),
  };
}

describe("synchronous cell preparation", () => {
  it("transpiles TypeScript while preserving source and analysis metadata", () => {
    const source = "$<number>(() => (1 as number) + 1)";
    const { analysis, result } = prepare(source);

    expect(result.ok).toBe(true);
    expect(result.source).toBe(source);
    expect(result.analysis).toBe(analysis);
    expect(result.analysis.annotation?.text).toBe("number");
    if (result.ok) {
      expect(result.code).toContain("$(() => 1 + 1)");
      expect(result.code).not.toContain("<number>");
    }
  });

  it("rejects invalid TypeScript before execution preparation", () => {
    const { result } = prepare("$(() => {");

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_TYPESCRIPT",
        message: INVALID_TYPESCRIPT_ERROR,
      },
    });
  });

  it("rejects static, dynamic, and type imports", () => {
    for (const source of [
      'import value from "package"; $(() => value)',
      '$(() => import("package"))',
      '$<import("package").Value>(() => 1)',
    ]) {
      expect(prepare(source).result).toMatchObject({
        ok: false,
        error: {
          code: "IMPORT_UNSUPPORTED",
          message: IMPORTS_UNSUPPORTED_ERROR,
        },
      });
    }
  });

  it("rejects exports and import.meta with a stable module-syntax error", () => {
    for (const source of [
      "export const value = 1; $(() => value)",
      "const value = 1; export { value }; $(() => value)",
      "export default $(() => 1)",
      "$(() => import.meta.url)",
    ]) {
      expect(prepare(source).result).toMatchObject({
        ok: false,
        error: {
          code: "MODULE_SYNTAX_UNSUPPORTED",
          message: MODULE_SYNTAX_UNSUPPORTED_ERROR,
        },
      });
    }
  });

  it("rejects top-level await but permits await syntax inside an uncalled async function", () => {
    expect(prepare("await Promise.resolve(); $(() => 1)").result).toMatchObject({
      ok: false,
      error: {
        code: "TOP_LEVEL_AWAIT_UNSUPPORTED",
        message: TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR,
      },
    });

    expect(
      prepare("async function unused() { await Promise.resolve() } $(() => 1)")
        .result.ok,
    ).toBe(true);
  });
});
