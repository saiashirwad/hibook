import { Show, untrack } from "solid-js";
import styles from "./App.module.css";
import NotebookTree from "./ui/NotebookTree";
import { createNotebookController } from "./ui/notebook-controller";
import { createNotebookViewState } from "./ui/view-state";

export default function App() {
  const controller = createNotebookController();
  const view = createNotebookViewState(untrack(controller.document));
  const notice = () =>
    controller.error()
      ? { tone: "error", text: controller.error() }
      : controller.cached()
        ? { tone: "info", text: "Showing cached results" }
        : undefined;

  return (
    <main
      class={styles.shell}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.shiftKey && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          controller.runAll();
        }
      }}
    >
      <Show when={notice()}>
        {(current) => (
          <p class={styles.notice} data-tone={current().tone} role="status">
            <span>{current().text}</span>
            <button
              type="button"
              class={styles.noticeAction}
              disabled={controller.hydrating() || controller.running()}
              onClick={() => controller.runAll()}
            >
              Run all
            </button>
          </p>
        )}
      </Show>

      <NotebookTree controller={controller} view={view} />
    </main>
  );
}
