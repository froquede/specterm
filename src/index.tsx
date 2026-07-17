/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { isMac } from "./lib/platform";
import "@xterm/xterm/css/xterm.css";
import "./styles/global.css";
import "./styles/markdown.css";
import "./styles/text.css";
import "./styles/file-tree.css";

// Platform hook for OS-specific styling (e.g. macOS traffic-light spacing).
if (isMac) {
  document.documentElement.classList.add("is-mac");
}

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
