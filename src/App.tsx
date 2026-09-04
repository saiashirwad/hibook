import { Show } from "solid-js";
import { TINY_COMMERCE_IDS } from "./demo/notebook";
import styles from "./App.module.css";
import NotebookTree from "./ui/NotebookTree";
import { createNotebookController } from "./ui/notebook-controller";
import { createNotebookViewState } from "./ui/view-state";

export default function App() {
  const controller = createNotebookController();
  const view = createNotebookViewState(TINY_COMMERCE_IDS.root);

  return (
    <main class={styles.shell}>
      <header class={styles.header}>
        <div class={styles.identity}>
          <p class={styles.kicker}>Reactive notebook</p>
          <h1 class={styles.title}>HiBook</h1>
        </div>
        <div class={styles.runGroup}>
          <span class={styles.runMessage} role="status" aria-live="polite">
            {controller.hydrating()
              ? "Checking saved results…"
              : controller.running()
                ? "Preparing and running…"
                : controller.error()
                  ? "Execution failed"
                  : controller.cached()
                    ? "Cached results · run to refresh"
                    : controller.prepared()
                      ? "Notebook ready"
                      : "Waiting to start…"}
          </span>
          <button
            type="button"
            class={styles.runButton}
            disabled={controller.hydrating() || controller.running()}
            onClick={() => controller.runAll()}
          >
            Run all
          </button>
        </div>
      </header>

      <Show when={controller.error()}>
        <p class={styles.applicationError} role="alert">
          {controller.error()}
        </p>
      </Show>

      <NotebookTree controller={controller} view={view} />
    </main>
  );
}
