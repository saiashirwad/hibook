import styles from "./App.module.css";

export default function App() {
  return (
    <main class={styles.shell}>
      <header class={styles.header}>
        <p class={styles.kicker}>Reactive notebook workspace</p>
        <h1 class={styles.title}>HiBook</h1>
      </header>
      <p class={styles.status}>
        The notebook is being built. Editing, execution, and persistence are not
        available yet.
      </p>
    </main>
  );
}
