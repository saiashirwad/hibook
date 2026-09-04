import { createEffect, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { CellId, NotebookDocument } from "../model/types";

export interface NotebookViewState {
  readonly selectedId: Accessor<CellId | undefined>;
  readonly zoomRootId: Accessor<CellId>;
  select(cellId: CellId | undefined): void;
  zoom(cellId: CellId): void;
  isCollapsed(cellId: CellId): boolean;
  toggleCollapsed(cellId: CellId): void;
  isPinned(cellId: CellId): boolean;
  togglePinned(cellId: CellId): void;
  renameDraft(cellId: CellId): string | undefined;
  renameError(cellId: CellId): string | undefined;
  beginRename(cellId: CellId, currentName: string): void;
  setRenameDraft(cellId: CellId, draft: string): void;
  setRenameError(cellId: CellId, error: string | undefined): void;
  finishRename(cellId: CellId): void;
  cancelRename(cellId: CellId): void;
}

interface PersistedViewState {
  readonly zoomRootId?: CellId;
  readonly selectedId?: CellId | undefined;
  readonly collapsed?: readonly CellId[];
  readonly pinned?: readonly CellId[];
}

function storageKey(rootId: CellId): string {
  return `hibook.view.${rootId}`;
}

function readPersisted(rootId: CellId): PersistedViewState {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(rootId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as PersistedViewState)
      : {};
  } catch {
    return {};
  }
}

function writePersisted(rootId: CellId, state: PersistedViewState): void {
  try {
    globalThis.localStorage?.setItem(storageKey(rootId), JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

function toggled(set: ReadonlySet<CellId>, cellId: CellId): ReadonlySet<CellId> {
  const next = new Set(set);
  if (!next.delete(cellId)) next.add(cellId);
  return next;
}

export function createNotebookViewState(
  document: NotebookDocument,
): NotebookViewState {
  const known = (cellId: CellId | undefined): cellId is CellId =>
    cellId !== undefined && Object.hasOwn(document.cells, cellId);
  const knownIds = (ids: readonly CellId[] | undefined): ReadonlySet<CellId> =>
    new Set((ids ?? []).filter(known));
  const persisted = readPersisted(document.rootId);

  const [selectedId, setSelectedId] = createSignal<CellId | undefined>(
    known(persisted.selectedId) ? persisted.selectedId : undefined,
  );
  const [zoomRootId, setZoomRootId] = createSignal<CellId>(
    known(persisted.zoomRootId) ? persisted.zoomRootId : document.rootId,
  );
  const [collapsedIds, setCollapsedIds] = createSignal(knownIds(persisted.collapsed));
  const [pinnedIds, setPinnedIds] = createSignal(knownIds(persisted.pinned));
  const [renameDrafts, setRenameDrafts] = createSignal<
    Readonly<Record<CellId, string>>
  >({});
  const [renameErrors, setRenameErrors] = createSignal<
    Readonly<Record<CellId, string>>
  >({});

  createEffect(
    (): PersistedViewState => ({
      zoomRootId: zoomRootId(),
      selectedId: selectedId(),
      collapsed: [...collapsedIds()],
      pinned: [...pinnedIds()],
    }),
    (state) => writePersisted(document.rootId, state),
  );

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
      setCollapsedIds((current) => toggled(current, cellId));
    },
    isPinned: (cellId) => pinnedIds().has(cellId),
    togglePinned(cellId) {
      setPinnedIds((current) => toggled(current, cellId));
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
