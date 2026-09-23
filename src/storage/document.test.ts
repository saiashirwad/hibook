import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { NotebookDocument } from "../model/types";
import { DocumentStore, exportNotebook, parseNotebook } from "./document";

function notebook(source: string): NotebookDocument {
  return {
    rootId: "root",
    cells: {
      root: { id: "root", name: "notebook", kind: "text", source, classes: [], metadata: {}, children: [] },
    },
  };
}

describe("durable notebook document", () => {
  it("has no default document and saves the latest edit in order", async () => {
    const store = new DocumentStore();
    expect(await store.load()).toBeUndefined();
    const first = store.save({ formatVersion: 1, document: notebook("first"), executionEnabled: false });
    const second = store.save({ formatVersion: 1, document: notebook("second"), executionEnabled: true });
    await Promise.all([first, second]);
    expect(await new DocumentStore().load()).toEqual({
      formatVersion: 1, document: notebook("second"), executionEnabled: true,
    });
  });

  it("exports source but disables execution on import", () => {
    const exported = exportNotebook(notebook("window.alert('hi')"));
    expect(parseNotebook(JSON.parse(exported) as unknown)).toEqual({
      formatVersion: 1,
      document: notebook("window.alert('hi')"),
      executionEnabled: false,
    });
  });

  it("rejects future versions and malformed trees without replacing a document", async () => {
    expect(() => parseNotebook({ formatVersion: 2, document: notebook("x"), executionEnabled: false })).toThrow("Unsupported");
    const broken = notebook("x");
    broken.cells.root?.children.push("missing");
    expect(() => parseNotebook({ formatVersion: 1, document: broken, executionEnabled: false })).toThrow("Invalid notebook");
  });
});
