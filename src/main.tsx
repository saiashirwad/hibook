import { render } from "@solidjs/web";

import App from "./App";
import "./theme.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Application root element was not found");
}

render(() => <App />, root);
