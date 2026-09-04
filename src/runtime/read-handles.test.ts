import { describe, expect, it } from "vitest";
import type { Cell, NotebookDocument } from "../model/types";
import { buildNotebookReadHandles } from "./read-handles";
import {
  createRuntimeRegistry,
  ensureCellRuntime,
  synchronizeRuntimeRegistry,
} from "./registry";

function cell(
  id: string,
  name: string | undefined,
  source: string,
  children: string[] = [],
): Cell {
  return {
    id,
    ...(name === undefined ? {} : { name }),
    kind: "text",
    source,
    classes: [],
    metadata: {},
    children,
  };
}

describe("notebook read handles", () => {
  it("shares direct and explicit child handles and reads live values at access time", () => {
    const document: NotebookDocument = {
      rootId: "root",
      cells: {
        root: cell("root", "notebook", "Notebook", ["data"]),
        data: cell("data", "data", "Data", ["products"]),
        products: cell("products", "products", "initial"),
      },
    };
    const registry = createRuntimeRegistry();
    synchronizeRuntimeRegistry(registry, document);
    const handles = buildNotebookReadHandles(document, registry);
    const root = handles.get("root");
    const data = handles.get("data");
    const products = handles.get("products");

    expect(root?.children.data).toBe(data);
    expect(root?.data).toBe(data);
    expect(data?.children.products).toBe(products);
    expect(data?.products).toBe(products);
    expect(handles.contextFor("products")).toEqual({
      self: products,
      parent: data,
      root,
    });
    expect(handles.contextFor("root").parent).toBeUndefined();

    ensureCellRuntime(registry, "products").publish(["lamp", "chair"]);
    expect(products?.value).toEqual(["lamp", "chair"]);
    expect(products?.peek()).toEqual(["lamp", "chair"]);
    ensureCellRuntime(registry, "products").publish(["vase"]);
    expect(products?.value).toEqual(["vase"]);
    expect(products?.peek()).toEqual(["vase"]);
  });

  it("freezes the public surface and exposes no document arrays or mutation API", () => {
    const document: NotebookDocument = {
      rootId: "root",
      cells: {
        root: cell("root", "notebook", "Notebook", ["child"]),
        child: cell("child", "child", "Child"),
      },
    };
    const registry = createRuntimeRegistry();
    synchronizeRuntimeRegistry(registry, document);
    const root = buildNotebookReadHandles(document, registry).get("root");

    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root?.children)).toBe(true);
    expect(Array.isArray(root?.children)).toBe(false);
    expect(Object.keys(root ?? {})).toEqual([
      "child",
      "id",
      "name",
      "kind",
      "text",
      "value",
      "peek",
      "children",
    ]);
    expect(root).not.toHaveProperty("update");
    expect(root).not.toHaveProperty("append");
    expect(root).not.toHaveProperty("remove");
    expect(root).not.toHaveProperty("replaceChildren");
  });
});
