import { describe, expect, it } from "vitest";
import {
  appendChild,
  createNotebook,
  insertSibling,
  move,
  parentOf,
  remove,
  update,
} from "./commands";
import type {
  Cell,
  CellInput,
  CommandResult,
  NotebookDocument,
} from "./types";

function makeCell(
  id: string,
  name: string,
  children: string[] = [],
): Cell {
  return {
    id,
    kind: "text",
    name,
    source: `source:${id}`,
    classes: [],
    metadata: {},
    children,
  };
}

function makeDocument(): NotebookDocument {
  return {
    rootId: "root",
    cells: {
      root: makeCell("root", "notebook", ["left", "right"]),
      left: makeCell("left", "left", ["branch", "leftTail"]),
      branch: makeCell("branch", "branch", ["leaf"]),
      leaf: makeCell("leaf", "leaf"),
      leftTail: makeCell("leftTail", "tail"),
      right: makeCell("right", "right"),
    },
  };
}

function newCell(id: string, name?: string): CellInput {
  return {
    id,
    kind: "javascript",
    ...(name === undefined ? {} : { name }),
    source: `$(() => ${JSON.stringify(id)})`,
    classes: ["code"],
    metadata: { editor: { folded: false } },
  };
}

function documentFrom(result: CommandResult): NotebookDocument {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.document;
}

function expectError(result: CommandResult, code: string): void {
  expect(result).toMatchObject({ ok: false, error: { code } });
}

describe("notebook commands", () => {
  it("creates a normalized root with a deterministic readable name and owns input data", () => {
    const classes = ["root"];
    const nestedMetadata = { folded: false };
    const input: CellInput = {
      id: "root",
      kind: "text",
      source: "Notebook",
      classes,
      metadata: { editor: nestedMetadata },
    };

    const document = documentFrom(
      createNotebook(input, { random: () => 0 }),
    );
    classes.push("changed-outside");
    nestedMetadata.folded = true;

    expect(document).toEqual({
      rootId: "root",
      cells: {
        root: {
          id: "root",
          kind: "text",
          name: "amberCloud",
          source: "Notebook",
          classes: ["root"],
          metadata: { editor: { folded: false } },
          children: [],
        },
      },
    });
  });

  it("appends and inserts named siblings without rewriting source", () => {
    const initial = makeDocument();
    const appended = documentFrom(
      appendChild(initial, "right", newCell("first", "first")),
    );
    const insertedBefore = documentFrom(
      insertSibling(appended, "first", "before", newCell("before", "before")),
    );
    const insertedAfter = documentFrom(
      insertSibling(
        insertedBefore,
        "first",
        "after",
        newCell("after", "after"),
      ),
    );

    expect(insertedAfter.cells.right?.children).toEqual([
      "before",
      "first",
      "after",
    ]);
    expect(insertedAfter.cells.first?.source).toBe('$(() => "first")');
    expect(initial.cells.right?.children).toEqual([]);
  });

  it("updates only cell data and clones patch arrays and nested metadata", () => {
    const initial = makeDocument();
    const classes = ["result"];
    const nestedMetadata = { width: 4 };
    const updated = documentFrom(
      update(initial, "branch", {
        kind: "markdown",
        name: "renamedBranch",
        source: "# Result",
        classes,
        metadata: { layout: nestedMetadata },
      }),
    );
    classes.push("outside");
    nestedMetadata.width = 99;

    expect(updated.cells.branch).toEqual({
      ...initial.cells.branch,
      kind: "markdown",
      name: "renamedBranch",
      source: "# Result",
      classes: ["result"],
      metadata: { layout: { width: 4 } },
    });
    expect(updated.cells.branch?.children).toEqual(["leaf"]);
    expect(initial.cells.branch?.name).toBe("branch");
  });

  it("moves within a parent by post-removal child index and sibling target", () => {
    const initial: NotebookDocument = {
      rootId: "root",
      cells: {
        root: makeCell("root", "rootCell", ["a", "b", "c"]),
        a: makeCell("a", "a"),
        b: makeCell("b", "b"),
        c: makeCell("c", "c"),
      },
    };

    const indexed = documentFrom(
      move(initial, "a", { type: "child", parentId: "root", index: 2 }),
    );
    expect(indexed.cells.root?.children).toEqual(["b", "c", "a"]);

    const relative = documentFrom(
      move(indexed, "c", {
        type: "sibling",
        referenceId: "b",
        position: "before",
      }),
    );
    expect(relative.cells.root?.children).toEqual(["c", "b", "a"]);
    expect(initial.cells.root?.children).toEqual(["a", "b", "c"]);
  });

  it("moves a whole subtree across parents without changing its data", () => {
    const initial = makeDocument();
    const moved = documentFrom(
      move(initial, "branch", {
        type: "child",
        parentId: "right",
        index: 0,
      }),
    );

    expect(moved.cells.left?.children).toEqual(["leftTail"]);
    expect(moved.cells.right?.children).toEqual(["branch"]);
    expect(moved.cells.branch).toEqual(initial.cells.branch);
    expect(moved.cells.leaf).toEqual(initial.cells.leaf);
    expect(parentOf(moved, "leaf")).toEqual({
      ok: true,
      parentId: "branch",
    });
    expect(parentOf(moved, "root")).toEqual({ ok: true, parentId: undefined });
  });

  it("deletes the selected cell and its complete subtree", () => {
    const initial = makeDocument();
    const deleted = documentFrom(remove(initial, "branch"));

    expect(deleted.cells.left?.children).toEqual(["leftTail"]);
    expect(Object.keys(deleted.cells).sort()).toEqual([
      "left",
      "leftTail",
      "right",
      "root",
    ]);
    expect(initial.cells.branch).toBeDefined();
    expect(initial.cells.leaf).toBeDefined();
  });

  it("protects the root from removal, movement, and sibling insertion", () => {
    const initial = makeDocument();
    const before = structuredClone(initial);

    expectError(remove(initial, "root"), "ROOT_PROTECTED");
    expectError(
      move(initial, "root", { type: "child", parentId: "left" }),
      "ROOT_PROTECTED",
    );
    expectError(
      insertSibling(initial, "root", "after", newCell("other", "other")),
      "ROOT_HAS_NO_SIBLINGS",
    );
    expect(initial).toEqual(before);
  });

  it("rejects self and descendant move targets atomically", () => {
    const initial = makeDocument();
    const before = structuredClone(initial);

    expectError(
      move(initial, "branch", { type: "child", parentId: "branch" }),
      "MOVE_INTO_SELF_OR_DESCENDANT",
    );
    expectError(
      move(initial, "branch", { type: "child", parentId: "leaf" }),
      "MOVE_INTO_SELF_OR_DESCENDANT",
    );
    expectError(
      move(initial, "branch", {
        type: "sibling",
        referenceId: "leaf",
        position: "after",
      }),
      "MOVE_INTO_SELF_OR_DESCENDANT",
    );
    expect(initial).toEqual(before);
  });

  it("rejects duplicate IDs and invalid patches without changing the input", () => {
    const initial = makeDocument();
    const before = structuredClone(initial);

    expectError(
      appendChild(initial, "right", newCell("leaf", "newLeaf")),
      "DUPLICATE_ID",
    );
    expectError(
      update(initial, "leaf", { children: [] } as never),
      "INVALID_PATCH",
    );
    expect(initial).toEqual(before);
  });

  it("enforces sibling uniqueness on create, rename, and cross-parent move", () => {
    const initial = makeDocument();
    const before = structuredClone(initial);

    expectError(
      appendChild(initial, "root", newCell("duplicateName", "left")),
      "NAME_CONFLICT",
    );
    expectError(update(initial, "right", { name: "left" }), "NAME_CONFLICT");

    const conflictDocument: NotebookDocument = {
      rootId: "root",
      cells: {
        root: makeCell("root", "rootCell", ["left", "right"]),
        left: makeCell("left", "left", ["moving"]),
        moving: makeCell("moving", "shared"),
        right: makeCell("right", "right", ["occupied"]),
        occupied: makeCell("occupied", "shared"),
      },
    };
    expectError(
      move(conflictDocument, "moving", {
        type: "child",
        parentId: "right",
      }),
      "NAME_CONFLICT",
    );
    expect(initial).toEqual(before);
    expect(conflictDocument.cells.left?.children).toEqual(["moving"]);
  });

  it("allows names to repeat across ancestor/descendant and unrelated scopes", () => {
    const initial = makeDocument();
    const descendantReuse = documentFrom(
      appendChild(initial, "branch", newCell("nestedBranch", "branch")),
    );
    const leftReuse = documentFrom(
      appendChild(descendantReuse, "leaf", newCell("leftShared", "shared")),
    );
    const unrelatedReuse = documentFrom(
      appendChild(leftReuse, "right", newCell("rightShared", "shared")),
    );

    expect(unrelatedReuse.cells.nestedBranch?.name).toBe("branch");
    expect(unrelatedReuse.cells.leftShared?.name).toBe("shared");
    expect(unrelatedReuse.cells.rightShared?.name).toBe("shared");
  });

  it("rejects invalid and reserved names without rewriting cell source", () => {
    const initial = makeDocument();
    const source = initial.cells.branch?.source;

    expectError(update(initial, "branch", { name: "two words" }), "INVALID_NAME");
    expectError(update(initial, "branch", { name: "children" }), "RESERVED_NAME");
    expectError(
      appendChild(initial, "right", newCell("bad", "1stCell")),
      "INVALID_NAME",
    );
    expect(initial.cells.branch?.source).toBe(source);
  });

  it("avoids generated-name collisions deterministically", () => {
    const initial: NotebookDocument = {
      rootId: "root",
      cells: {
        root: makeCell("root", "notebook", ["existing"]),
        existing: makeCell("existing", "amberCloud"),
      },
    };

    const result = documentFrom(
      appendChild(initial, "root", newCell("generated"), {
        random: () => 0,
      }),
    );
    expect(result.cells.generated?.name).toBe("amberFern");
  });
});
