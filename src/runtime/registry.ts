import { createRoot, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { CellId, NotebookDocument } from "../model/types";

export type CellRunStatus =
  | "idle"
  | "pending"
  | "success"
  | "error"
  | "cycle";

export interface CellRuntime<T = unknown> {
  readonly value: Accessor<T>;
  peek(): T;
  readonly status: Accessor<CellRunStatus>;
  readonly error: Accessor<string | undefined>;
  readonly version: Accessor<number>;
  publish(value: T): void;
  begin(): void;
  fail(error: unknown): void;
  markCycle(): void;
  dispose(): void;
}

export type CellRuntimeRegistry = Map<CellId, CellRuntime>;

interface ValueBox<T> {
  readonly value: T;
}

function failureMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.message;
    }
  } catch {
    return "Unknown error";
  }

  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

export function createCellRuntime<T = unknown>(initialValue?: T): CellRuntime<T> {
  let currentValue = initialValue as T;
  let disposed = false;

  return createRoot((disposeOwner) => {
    const [valueBox, setValueBox] = createSignal<ValueBox<T>>({
      value: currentValue,
    });
    const [status, setStatus] = createSignal<CellRunStatus>("idle");
    const [error, setError] = createSignal<string | undefined>();
    const [version, setVersion] = createSignal(0);

    const resolve = (nextStatus: "success" | "error" | "cycle"): void => {
      setStatus(nextStatus);
      setVersion((current) => current + 1);
    };

    return {
      value: () => valueBox().value,
      peek: () => currentValue,
      status,
      error,
      version,
      publish(nextValue: T): void {
        if (disposed) {
          return;
        }
        currentValue = nextValue;
        setValueBox({ value: nextValue });
        setError(undefined);
        resolve("success");
      },
      begin(): void {
        if (disposed) {
          return;
        }
        setError(undefined);
        setStatus("pending");
      },
      fail(reason: unknown): void {
        if (disposed) {
          return;
        }
        setError(failureMessage(reason));
        resolve("error");
      },
      markCycle(): void {
        if (disposed) {
          return;
        }
        setError("Reactive dependency cycle");
        resolve("cycle");
      },
      dispose(): void {
        if (disposed) {
          return;
        }
        disposed = true;
        disposeOwner();
      },
    };
  });
}

export function createRuntimeRegistry(): CellRuntimeRegistry {
  return new Map<CellId, CellRuntime>();
}

export function ensureCellRuntime(
  registry: CellRuntimeRegistry,
  cellId: CellId,
): CellRuntime {
  const existing = registry.get(cellId);
  if (existing) {
    return existing;
  }

  const runtime = createCellRuntime();
  registry.set(cellId, runtime);
  return runtime;
}

export function synchronizeRuntimeRegistry(
  registry: CellRuntimeRegistry,
  document: NotebookDocument,
): void {
  for (const cell of Object.values(document.cells)) {
    const runtime = ensureCellRuntime(registry, cell.id);
    if (
      cell.kind === "text" &&
      (runtime.status() !== "success" || runtime.peek() !== cell.source)
    ) {
      runtime.publish(cell.source);
    }
  }

  for (const [cellId, runtime] of registry) {
    if (!Object.hasOwn(document.cells, cellId)) {
      runtime.dispose();
      registry.delete(cellId);
    }
  }
}
