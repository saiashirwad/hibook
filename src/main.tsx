import { render } from "@solidjs/web";

import App from "./App";
import { DocumentStore, type SavedNotebook } from "./storage/document";
import "./theme.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Application root element was not found");
}

const store = new DocumentStore();
let initial: SavedNotebook | undefined;
let loadError: string | undefined;
try {
  initial = await store.load();
} catch (error) {
  loadError = error instanceof Error ? error.message : "Cannot open local notebook storage";
}

render(() => <App initial={initial} loadError={loadError} store={store} />, root);
