import { describe, expect, it } from "vitest";
import type { Cell, CellKind, NotebookDocument } from "../model/types";
import {
  buildNotebookDependencyGraph,
  downstreamClosure,
} from "./dependency-graph";

function cell(
  id: string,
  kind: CellKind,
  source: string,
  children: string[] = [],
): Cell {
  return {
    id,
    name: id,
    kind,
    source,
    classes: [],
    metadata: {},
    children,
  };
}

function js(body: string): string {
  return `$(({ root, self }) => ${body})`;
}

describe("notebook dependency graph", () => {
  it("builds deterministic maps and topological layers in document order", () => {
    const notebook: NotebookDocument = {
      rootId: "root",
      cells: {
        root: cell("root", "text", "Notebook", ["a", "b", "c", "d", "bad"]),
        a: cell("a", "javascript", js("1")),
        b: cell("b", "javascript", js("2")),
        c: cell("c", "javascript", js("root.a.value + 1")),
        d: cell("d", "javascript", js("root.b.value + root.a.value")),
        bad: cell("bad", "javascript", js("root.missing.value")),
      },
    };

    const graph = buildNotebookDependencyGraph(notebook);
    expect(graph.order).toEqual(["root", "a", "b", "c", "d", "bad"]);
    expect([...graph.dependencies]).toEqual([
      ["root", []],
      ["a", []],
      ["b", []],
      ["c", ["a"]],
      ["d", ["b", "a"]],
      ["bad", []],
    ]);
    expect([...graph.dependents]).toEqual([
      ["root", []],
      ["a", ["c", "d"]],
      ["b", ["d"]],
      ["c", []],
      ["d", []],
      ["bad", []],
    ]);
    expect(graph.layers).toEqual([
      ["root", "a", "b", "bad"],
      ["c", "d"],
    ]);
    expect(graph.analyses.get("bad")?.issues).toMatchObject([
      { code: "MISSING_TARGET", classification: "missing" },
    ]);
  });

  it("finds strongly connected groups and self-cycles without blocking unrelated branches", () => {
    const notebook: NotebookDocument = {
      rootId: "root",
      cells: {
        root: cell("root", "text", "Notebook", ["a", "b", "after", "self", "u", "v"]),
        a: cell("a", "javascript", js("root.b.value")),
        b: cell("b", "javascript", js("root.a.value")),
        after: cell("after", "javascript", js("root.a.value")),
        self: cell("self", "javascript", js("self.value")),
        u: cell("u", "javascript", js("1")),
        v: cell("v", "javascript", js("root.u.value")),
      },
    };

    const graph = buildNotebookDependencyGraph(notebook);
    expect(graph.cycleGroups).toEqual([
      { cellIds: ["a", "b"] },
      { cellIds: ["self"] },
    ]);
    expect(graph.cycleMembers).toEqual(["a", "b", "self"]);
    expect(graph.layers).toEqual([
      ["root", "u"],
      ["v"],
    ]);
    expect(graph.blockedByCycles).toEqual(["after"]);
  });

  it("returns an ID-based downstream closure for one or many changed cells", () => {
    const notebook: NotebookDocument = {
      rootId: "root",
      cells: {
        root: cell("root", "text", "Notebook", ["source", "left", "right", "leaf"]),
        source: cell("source", "javascript", js("1")),
        left: cell("left", "javascript", js("root.source.value + 1")),
        right: cell("right", "javascript", js("root.source.value + 2")),
        leaf: cell(
          "leaf",
          "javascript",
          js("root.left.value + root.right.value"),
        ),
      },
    };
    const graph = buildNotebookDependencyGraph(notebook);

    expect(downstreamClosure(graph, ["source"])).toEqual([
      "source",
      "left",
      "right",
      "leaf",
    ]);
    expect(downstreamClosure(graph, ["right", "left", "unknown"])).toEqual([
      "left",
      "right",
      "leaf",
    ]);
    expect(downstreamClosure(graph, [])).toEqual([]);
  });
});
