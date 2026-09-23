import { Show, createSignal, onCleanup, untrack } from "solid-js";
import type { NotebookDocument } from "./model/types";
import { exportNotebook, parseNotebook, type DocumentStore, type SavedNotebook } from "./storage/document";
import styles from "./App.module.css";
import NotebookTree from "./ui/NotebookTree";
import { createNotebookController } from "./ui/notebook-controller";
import { createNotebookViewState } from "./ui/view-state";

interface AppProps {
  readonly initial: SavedNotebook | undefined;
  readonly loadError: string | undefined;
  readonly store: DocumentStore;
}

function blankDocument(): NotebookDocument {
  const id = `root-${crypto.randomUUID()}`;
  return {
    rootId: id,
    cells: {
      [id]: { id, name: "notebook", kind: "text", source: "", classes: [], metadata: {}, children: [] },
    },
  };
}

function Workspace(props: {
  readonly record: SavedNotebook;
  readonly store: DocumentStore;
  readonly onOpenImport: () => void;
  readonly unsaved: boolean;
}) {
  const [saveStatus, setSaveStatus] = createSignal(props.unsaved ? "Not saved yet" : "Saved locally");
  let saveGeneration = 0;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(savedTimer));
  const controller = createNotebookController({
    document: props.record.document,
    executionEnabled: props.record.executionEnabled,
    onDocumentChange(document, executionEnabled) {
      const generation = ++saveGeneration;
      clearTimeout(savedTimer);
      setSaveStatus("Saving…");
      void props.store.save({ formatVersion: 1, document, executionEnabled }).then(
        () => {
          if (generation === saveGeneration) {
            savedTimer = setTimeout(() => setSaveStatus("Saved locally"), 650);
          }
        },
        () => { if (generation === saveGeneration) setSaveStatus("Save failed — export a copy"); },
      );
    },
  });
  const view = createNotebookViewState(untrack(controller.document));
  const notice = () => controller.error()
    ? controller.error()
    : !controller.executionEnabled() && Object.values(controller.document().cells).some((cell) => cell.kind !== "text")
      ? "Code is paused. Run all only if you trust this notebook."
      : controller.cached() ? "Showing cached results" : undefined;

  const download = () => {
    const blob = new Blob([exportNotebook(controller.document())], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "hibook.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <main class={styles.shell} onKeyDown={(event) => {
      if (controller.executionEnabled() && event.key === "Enter" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        controller.runAll();
      }
    }}>
      <header class={styles.toolbar}>
        <strong class={styles.brand}>HiBook</strong>
        <span class={styles.saveStatus} role="status">{saveStatus()}</span>
        <div class={styles.tools}>
          <button type="button" disabled={!controller.canUndo()} onClick={() => controller.undo()} title="Undo document edit">Undo</button>
          <button type="button" disabled={!controller.canRedo()} onClick={() => controller.redo()} title="Redo document edit">Redo</button>
          <button type="button" onClick={props.onOpenImport}>Import JSON</button>
          <button type="button" onClick={download}>Export JSON</button>
        </div>
      </header>
      <Show when={notice()}>
        <p class={styles.notice} role="status">
          <span>{notice()}</span>
          <button type="button" class={styles.noticeAction} onClick={() => controller.runAll()}>
            Run all
          </button>
        </p>
      </Show>
      <NotebookTree controller={controller} view={view} />
    </main>
  );
}

export default function App(props: AppProps) {
  const [record, setRecord] = createSignal<SavedNotebook | undefined>(props.initial);
  const [loadError, setLoadError] = createSignal(props.loadError);
  const [importError, setImportError] = createSignal<string | undefined>();
  let fileInput: HTMLInputElement | undefined;
  // An empty install is an unsaved blank document, not a copy of the demo.
  const [blank] = createSignal<SavedNotebook>({
    formatVersion: 1, document: blankDocument(), executionEnabled: false,
  });
  const current = () => record() ?? blank();

  const importFile = async (file: File) => {
    try {
      const parsed = parseNotebook(JSON.parse(await file.text()) as unknown);
      if (!confirm("Replace this document with the imported notebook? Export your current work first. Imported code will stay paused until you choose Run all.")) return;
      const imported = { ...parsed, executionEnabled: false };
      await props.store.save(imported);
      setImportError(undefined);
      setLoadError(undefined);
      setRecord(imported);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed");
    }
  };

  return (
    <>
      <input
        ref={(element) => { fileInput = element; }}
        type="file"
        accept="application/json,.json"
        class={styles.fileInput}
        aria-label="Import HiBook JSON"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void importFile(file);
          event.currentTarget.value = "";
        }}
      />
      <Show when={loadError()} fallback={
        <Show keyed when={current()}>
          {(saved) => <Workspace record={saved} store={props.store} unsaved={!record()} onOpenImport={() => fileInput?.click()} />}
        </Show>
      }>
        <main class={styles.recovery}>
          <h1>We couldn’t open your local notebook</h1>
          <p>{loadError()}</p>
          <p>Nothing has been replaced. You can import a backup, or check this browser’s storage settings.</p>
          <button type="button" onClick={() => fileInput?.click()}>Import JSON backup</button>
        </main>
      </Show>
      <Show when={importError()}><p class={styles.importError} role="alert">{importError()}</p></Show>
    </>
  );
}
