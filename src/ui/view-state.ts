import { createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { CellId, CellKind } from "../model/types";

export type DisclosurePanel = "source" | "output" | "type";

export interface NotebookViewState {
  readonly selectedId: Accessor<CellId>;
  readonly zoomRootId: Accessor<CellId>;
  select(cellId: CellId): void;
  zoom(cellId: CellId): void;
  isCollapsed(cellId: CellId): boolean;
  toggleCollapsed(cellId: CellId): void;
  isDisclosureOpen(
    cellId: CellId,
    panel: DisclosurePanel,
    kind: CellKind,
  ): boolean;
  toggleDisclosure(cellId: CellId, panel: DisclosurePanel, kind: CellKind): void;
  renameDraft(cellId: CellId): string | undefined;
  renameError(cellId: CellId): string | undefined;
  beginRename(cellId: CellId, currentName: string): void;
  setRenameDraft(cellId: CellId, draft: string): void;
  setRenameError(cellId: CellId, error: string | undefined): void;
  finishRename(cellId: CellId): void;
  cancelRename(cellId: CellId): void;
}

function defaultDisclosure(panel: DisclosurePanel, kind: CellKind): boolean {
  if (panel === "output") return kind !== "text";
  return panel === "source" && kind === "text";
}

function disclosureKey(cellId: CellId, panel: DisclosurePanel): string {
  return `${cellId}:${panel}`;
}

export function createNotebookViewState(rootId: CellId): NotebookViewState {
  const [selectedId, setSelectedId] = createSignal<CellId>(rootId);
  const [zoomRootId, setZoomRootId] = createSignal<CellId>(rootId);
  const [collapsedIds, setCollapsedIds] = createSignal<ReadonlySet<CellId>>(
    new Set<CellId>(),
  );
  const [disclosures, setDisclosures] = createSignal<
    Readonly<Record<string, boolean>>
  >({});
  const [renameDrafts, setRenameDrafts] = createSignal<
    Readonly<Record<CellId, string>>
  >({});
  const [renameErrors, setRenameErrors] = createSignal<
    Readonly<Record<CellId, string>>
  >({});

  const removeKey = (
    record: Readonly<Record<CellId, string>>,
    cellId: CellId,
  ): Readonly<Record<CellId, string>> => {
    const next = { ...record };
    delete next[cellId];
    return next;
  };

  return {
    selectedId,
    zoomRootId,
    select: setSelectedId,
    zoom(cellId) {
      setZoomRootId(cellId);
      setSelectedId(cellId);
    },
    isCollapsed: (cellId) => collapsedIds().has(cellId),
    toggleCollapsed(cellId) {
      setCollapsedIds((current) => {
        const next = new Set(current);
        if (next.has(cellId)) next.delete(cellId);
        else next.add(cellId);
        return next;
      });
    },
    isDisclosureOpen(cellId, panel, kind) {
      return (
        disclosures()[disclosureKey(cellId, panel)] ??
        defaultDisclosure(panel, kind)
      );
    },
    toggleDisclosure(cellId, panel, kind) {
      const key = disclosureKey(cellId, panel);
      setDisclosures((current) => ({
        ...current,
        [key]: !(current[key] ?? defaultDisclosure(panel, kind)),
      }));
    },
    renameDraft: (cellId) => renameDrafts()[cellId],
    renameError: (cellId) => renameErrors()[cellId],
    beginRename(cellId, currentName) {
      setRenameDrafts((current) => ({ ...current, [cellId]: currentName }));
      setRenameErrors((current) => removeKey(current, cellId));
    },
    setRenameDraft(cellId, draft) {
      setRenameDrafts((current) => ({ ...current, [cellId]: draft }));
    },
    setRenameError(cellId, error) {
      setRenameErrors((current) =>
        error === undefined
          ? removeKey(current, cellId)
          : { ...current, [cellId]: error },
      );
    },
    finishRename(cellId) {
      setRenameDrafts((current) => removeKey(current, cellId));
      setRenameErrors((current) => removeKey(current, cellId));
    },
    cancelRename(cellId) {
      setRenameDrafts((current) => removeKey(current, cellId));
      setRenameErrors((current) => removeKey(current, cellId));
    },
  };
}
