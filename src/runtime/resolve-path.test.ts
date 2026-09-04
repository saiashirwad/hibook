import { describe, expect, it } from "vitest";
import type { Cell, NotebookDocument } from "../model/types";
import type {
  NotebookPath,
  NotebookPathHop,
  NotebookPathOriginKind,
} from "./analysis-types";
import { resolveNotebookPath } from "./resolve-path";

function cell(id: string, name: string, children: string[] = []): Cell {
  return {
    id,
    kind: "text",
    name,
    source: id,
    classes: [],
    metadata: {},
    children,
  };
}

function document(): NotebookDocument {
  return {
    rootId: "root-id",
    cells: {
      "root-id": cell("root-id", "notebook", ["data-id", "group-id"]),
      "data-id": cell("data-id", "data", ["products-id"]),
      "products-id": cell("products-id", "products"),
      "group-id": cell("group-id", "group", ["input-id", "calc-id"]),
      "input-id": cell("input-id", "input"),
      "calc-id": cell("calc-id", "calc", ["local-id"]),
      "local-id": cell("local-id", "local"),
    },
  };
}

function path(
  origin: NotebookPathOriginKind,
  hops: readonly ("children" | "dynamic" | string)[],
): NotebookPath {
  let offset = 1;
  const parsedHops: NotebookPathHop[] = hops.map((hop) => {
    const span = { start: offset, end: offset + hop.length };
    offset = span.end + 1;
    if (hop === "children") {
      return { kind: "children", span };
    }
    if (hop === "dynamic") {
      return { kind: "dynamic", span };
    }
    return { kind: "child", name: hop, span };
  });
  return {
    origin: { kind: origin, span: { start: 0, end: origin.length } },
    hops: parsedHops,
    valueSpan: { start: offset, end: offset + 5 },
    span: { start: 0, end: offset + 5 },
  };
}

describe("notebook path resolution", () => {
  it("uses root, parent, and self origins with direct and explicit child hops", () => {
    const notebook = document();

    expect(
      resolveNotebookPath(
        notebook,
        "calc-id",
        path("root", ["data", "products"]),
      ),
    ).toEqual({ status: "resolved", targetId: "products-id" });
    expect(
      resolveNotebookPath(
        notebook,
        "calc-id",
        path("root", ["children", "data", "products"]),
      ),
    ).toEqual({ status: "resolved", targetId: "products-id" });
    expect(
      resolveNotebookPath(notebook, "calc-id", path("parent", ["input"])),
    ).toEqual({ status: "resolved", targetId: "input-id" });
    expect(
      resolveNotebookPath(notebook, "calc-id", path("self", ["local"])),
    ).toEqual({ status: "resolved", targetId: "local-id" });
  });

  it("returns local structured outcomes for missing, dynamic, and invalid paths", () => {
    const notebook = document();

    expect(
      resolveNotebookPath(notebook, "calc-id", path("root", ["missing"])),
    ).toMatchObject({
      status: "missing",
      at: "child",
      fromId: "root-id",
      name: "missing",
    });
    expect(
      resolveNotebookPath(notebook, "calc-id", path("root", ["dynamic"])),
    ).toMatchObject({ status: "dynamic" });
    expect(
      resolveNotebookPath(notebook, "calc-id", path("root", ["children"])),
    ).toMatchObject({
      status: "invalid",
      reason: "children-segment-without-name",
    });
    expect(
      resolveNotebookPath(
        notebook,
        "calc-id",
        path("root", ["children", "children", "data"]),
      ),
    ).toMatchObject({
      status: "invalid",
      reason: "children-segment-without-name",
    });
    expect(
      resolveNotebookPath(notebook, "root-id", path("parent", [])),
    ).toMatchObject({ status: "missing", at: "parent" });
  });

  it("resolves duplicate references to one ID but reports distinct malformed matches", () => {
    const notebook = document();
    const repeated: NotebookDocument = {
      ...notebook,
      cells: {
        ...notebook.cells,
        "root-id": cell("root-id", "notebook", ["data-id", "data-id"]),
      },
    };
    expect(
      resolveNotebookPath(repeated, "calc-id", path("root", ["data"])),
    ).toEqual({ status: "resolved", targetId: "data-id" });

    const ambiguous: NotebookDocument = {
      ...notebook,
      cells: {
        ...notebook.cells,
        "root-id": cell("root-id", "notebook", ["data-id", "other-data"]),
        "other-data": cell("other-data", "data"),
        "other-parent": cell("other-parent", "otherParent", ["calc-id"]),
      },
    };
    expect(
      resolveNotebookPath(ambiguous, "calc-id", path("root", ["data"])),
    ).toEqual({
      status: "ambiguous",
      at: "child",
      fromId: "root-id",
      name: "data",
      span: expect.any(Object),
      candidateIds: ["data-id", "other-data"],
    });
    expect(
      resolveNotebookPath(ambiguous, "calc-id", path("parent", [])),
    ).toEqual({
      status: "ambiguous",
      at: "parent",
      span: { start: 0, end: 6 },
      candidateIds: ["group-id", "other-parent"],
    });
  });
});
