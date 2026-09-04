import { describe, expect, it } from "vitest";
import type { Cell, CellKind, NotebookDocument } from "../model/types";
import {
  createCellRuntime,
  createRuntimeRegistry,
  ensureCellRuntime,
  synchronizeRuntimeRegistry,
} from "./registry";

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

describe("cell runtime registry", () => {
  it("publishes boxed function values synchronously and tracks run outcomes", () => {
    const runtime = createCellRuntime();
    const functionValue = (): string => "published";

    expect(runtime.status()).toBe("idle");
    expect(runtime.error()).toBeUndefined();
    expect(runtime.version()).toBe(0);

    runtime.fail(new Error("first failure"));
    expect(runtime.status()).toBe("error");
    expect(runtime.error()).toBe("first failure");
    expect(runtime.version()).toBe(1);

    runtime.begin();
    expect(runtime.status()).toBe("pending");
    expect(runtime.error()).toBeUndefined();
    expect(runtime.version()).toBe(1);

    runtime.publish(functionValue);
    expect(runtime.status()).toBe("success");
    expect(runtime.error()).toBeUndefined();
    expect(runtime.value()).toBe(functionValue);
    expect(runtime.peek()).toBe(functionValue);
    expect(runtime.version()).toBe(2);

    runtime.markCycle();
    expect(runtime.status()).toBe("cycle");
    expect(runtime.error()).toBe("Reactive dependency cycle");
    expect(runtime.version()).toBe(3);
  });

  it("hydrates copied cached values without claiming a fresh run version", () => {
    const runtime = createCellRuntime();
    const cached = { rows: [{ id: 1 }] };

    expect(runtime.hydrateCached(cached)).toBe(true);
    expect(runtime.status()).toBe("cached");
    expect(runtime.version()).toBe(0);
    expect(runtime.peek()).toEqual(cached);
    expect(runtime.peek()).not.toBe(cached);

    cached.rows[0]!.id = 2;
    expect(runtime.peek()).toEqual({ rows: [{ id: 1 }] });

    runtime.publish({ rows: [{ id: 3 }] });
    expect(runtime.status()).toBe("success");
    expect(runtime.version()).toBe(1);
    expect(runtime.peek()).toEqual({ rows: [{ id: 3 }] });
  });

  it("stringifies hostile unknown failures without masking the failed run", () => {
    const runtime = createCellRuntime();
    const hostile = Object.create(null) as object;
    Object.defineProperty(hostile, "toString", {
      value: (): never => {
        throw new Error("conversion failed");
      },
    });

    runtime.fail(hostile);

    expect(runtime.status()).toBe("error");
    expect(runtime.error()).toBe("Unknown error");
    expect(runtime.version()).toBe(1);
  });

  it("synchronizes text sources without mutating documents and disposes removals", () => {
    const document: NotebookDocument = {
      rootId: "root",
      cells: {
        root: cell("root", "text", "Notebook", ["code"]),
        code: cell("code", "javascript", "$(() => 1)"),
      },
    };
    const serialized = JSON.stringify(document);
    const registry = createRuntimeRegistry();

    synchronizeRuntimeRegistry(registry, document);
    const rootRuntime = ensureCellRuntime(registry, "root");
    const removedRuntime = ensureCellRuntime(registry, "code");
    expect(rootRuntime.peek()).toBe("Notebook");
    expect(rootRuntime.status()).toBe("success");
    expect(rootRuntime.version()).toBe(1);
    expect(JSON.stringify(document)).toBe(serialized);

    synchronizeRuntimeRegistry(registry, document);
    expect(rootRuntime.version()).toBe(1);

    const changed: NotebookDocument = {
      rootId: "root",
      cells: {
        root: cell("root", "text", "Renamed notebook"),
      },
    };
    synchronizeRuntimeRegistry(registry, changed);
    expect(rootRuntime.peek()).toBe("Renamed notebook");
    expect(rootRuntime.version()).toBe(2);
    expect(registry.has("code")).toBe(false);

    removedRuntime.publish(99);
    expect(removedRuntime.status()).toBe("idle");
    expect(removedRuntime.version()).toBe(0);
  });
});
