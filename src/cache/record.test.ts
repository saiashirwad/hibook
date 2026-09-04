import { describe, expect, it } from "vitest";
import { prepareExecution } from "../compiler/fast-prepare";
import type { Cell, NotebookDocument } from "../model/types";
import {
  NOTEBOOK_CACHE_COMPATIBILITY,
  copyJsonSafeValue,
  createNotebookCacheRecord,
  validateNotebookCacheRecord,
} from "./record";

function notebook(source = "$(() => ({ answer: 42 }))"): NotebookDocument {
  const root: Cell = {
    id: "root",
    name: "root",
    kind: "text",
    source: "Notebook",
    classes: [],
    metadata: {},
    children: ["code"],
  };
  const code: Cell = {
    id: "code",
    name: "code",
    kind: "javascript",
    source,
    classes: [],
    metadata: {},
    children: [],
  };
  return { rootId: root.id, cells: { root, code } };
}

function exactRecord(document: NotebookDocument) {
  return createNotebookCacheRecord(
    document,
    prepareExecution(document),
    [["code", { answer: 42 }]],
    100,
  );
}

describe("notebook cache records", () => {
  it("accepts one exact complete revision and strips transient preparation timings", () => {
    const document = notebook();
    const prepared = prepareExecution(document);
    expect(prepared.timings.totalMs).toBeGreaterThanOrEqual(0);

    const record = createNotebookCacheRecord(
      document,
      prepared,
      [["code", { answer: 42 }]],
      123,
    );

    expect(validateNotebookCacheRecord(record, document)).toEqual(record);
    expect(record.prepared.timings).toMatchObject({
      totalMs: 0,
      analysisMs: 0,
      transpileMs: 0,
      cellCount: 2,
    });
  });

  it("accepts a complete rejected executable preparation", () => {
    const document = notebook('import value from "elsewhere"');
    const prepared = prepareExecution(document);
    expect(prepared.cells.find((cell) => cell.cellId === "code")).toMatchObject({
      ok: false,
      status: "invalid",
    });
    const record = createNotebookCacheRecord(document, prepared, [], 124);
    expect(validateNotebookCacheRecord(record, document)).toEqual(record);
  });

  it("rejects changed revisions, incompatible compilers, malformed graphs, and partial preparation atomically", () => {
    const document = notebook();
    const record = exactRecord(document);
    const changed = notebook("$(() => ({ answer: 43 }))");
    expect(validateNotebookCacheRecord(record, changed)).toBeUndefined();

    expect(
      validateNotebookCacheRecord(
        { ...record, compatibility: `${NOTEBOOK_CACHE_COMPATIBILITY}-other` },
        document,
      ),
    ).toBeUndefined();

    const malformedGraph = {
      ...record,
      prepared: {
        ...record.prepared,
        graph: { ...record.prepared.graph, layers: [["missing"]] },
      },
    };
    expect(validateNotebookCacheRecord(malformedGraph, document)).toBeUndefined();

    const partial = {
      ...record,
      prepared: {
        ...record.prepared,
        cells: record.prepared.cells.filter((cell) => cell.cellId !== "code"),
      },
    };
    expect(validateNotebookCacheRecord(partial, document)).toBeUndefined();

    const missingExecutableShape = structuredClone(record) as unknown as {
      prepared: { cells: Array<Record<string, unknown>> };
    };
    const executable = missingExecutableShape.prepared.cells.find(
      (cell) => cell.cellId === "code",
    );
    if (executable) Reflect.deleteProperty(executable, "code");
    expect(
      validateNotebookCacheRecord(missingExecutableShape, document),
    ).toBeUndefined();
  });

  it("clones safe values and omits one whole unsafe cell without invoking accessors", () => {
    const safe = Object.create(null) as Record<string, unknown>;
    safe.items = [null, true, 3, { label: "ok" }];
    const copied = copyJsonSafeValue(safe);
    expect(copied).toEqual({
      ok: true,
      value: { items: [null, true, 3, { label: "ok" }] },
    });
    if (copied.ok) {
      expect(copied.value).not.toBe(safe);
      const copiedObject = copied.value as Record<string, unknown>;
      expect(copiedObject.items).not.toBe(safe.items);
    }

    let getterCalls = 0;
    const unsafe = {};
    Object.defineProperty(unsafe, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "do not read";
      },
    });
    const document = notebook();
    const record = createNotebookCacheRecord(
      document,
      prepareExecution(document),
      [["code", unsafe]],
      200,
    );
    expect(record.values).toEqual({});
    expect(getterCalls).toBe(0);

    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    for (const value of [undefined, 1n, Symbol("x"), () => 1, Infinity, new Date(), cyclic]) {
      expect(copyJsonSafeValue(value).ok).toBe(false);
    }
  });
});
