import type { CellId, CellKind, NotebookDocument } from "../model/types";
import type { CellRuntimeRegistry } from "./registry";

export interface CellHandle {
  readonly id: CellId;
  readonly name: string | undefined;
  readonly kind: CellKind;
  readonly text: string;
  readonly value: unknown;
  readonly peek: () => unknown;
  readonly children: Readonly<Record<string, CellHandle>>;
  readonly [name: string]: unknown;
}

export interface RuntimeContext {
  readonly self: CellHandle;
  readonly parent: CellHandle | undefined;
  readonly root: CellHandle;
}

export interface NotebookReadHandles {
  get(cellId: CellId): CellHandle | undefined;
  contextFor(cellId: CellId): RuntimeContext;
}

function defineReadonlyValue(
  target: object,
  name: PropertyKey,
  value: unknown,
): void {
  Object.defineProperty(target, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
}

export function buildNotebookReadHandles(
  document: NotebookDocument,
  registry: CellRuntimeRegistry,
): NotebookReadHandles {
  const handles = new Map<CellId, CellHandle>();
  const parentIds = new Map<CellId, CellId>();

  for (const cell of Object.values(document.cells)) {
    for (const childId of cell.children) {
      if (!parentIds.has(childId)) {
        parentIds.set(childId, cell.id);
      }
    }
  }

  const build = (cellId: CellId): CellHandle => {
    const existing = handles.get(cellId);
    if (existing) {
      return existing;
    }

    const cell = document.cells[cellId];
    if (!cell) {
      throw new Error(`Unknown cell: ${cellId}`);
    }

    const surface = Object.create(null) as Record<PropertyKey, unknown>;
    const handle = surface as unknown as CellHandle;
    handles.set(cellId, handle);

    const namedChildren: Record<string, CellHandle> = Object.create(null) as Record<
      string,
      CellHandle
    >;
    for (const childId of cell.children) {
      const child = document.cells[childId];
      if (!child?.name) {
        continue;
      }
      const childHandle = build(childId);
      defineReadonlyValue(namedChildren, child.name, childHandle);
      defineReadonlyValue(surface, child.name, childHandle);
    }
    Object.freeze(namedChildren);

    defineReadonlyValue(surface, "id", cell.id);
    defineReadonlyValue(surface, "name", cell.name);
    defineReadonlyValue(surface, "kind", cell.kind);
    defineReadonlyValue(surface, "text", cell.source);
    Object.defineProperty(surface, "value", {
      configurable: false,
      enumerable: true,
      get: () => registry.get(cellId)?.peek(),
    });
    defineReadonlyValue(surface, "peek", () => registry.get(cellId)?.peek());
    defineReadonlyValue(surface, "children", namedChildren);
    Object.freeze(surface);
    return handle;
  };

  for (const cellId of Object.keys(document.cells)) {
    build(cellId);
  }

  const root = handles.get(document.rootId);
  if (!root) {
    throw new Error(`Unknown root cell: ${document.rootId}`);
  }

  return Object.freeze({
    get(cellId: CellId): CellHandle | undefined {
      return handles.get(cellId);
    },
    contextFor(cellId: CellId): RuntimeContext {
      const self = handles.get(cellId);
      if (!self) {
        throw new Error(`Unknown cell: ${cellId}`);
      }
      const parentId = parentIds.get(cellId);
      return Object.freeze({
        self,
        parent: parentId === undefined ? undefined : handles.get(parentId),
        root,
      });
    },
  });
}
