/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "@xterm/xterm/css/xterm.css";
import "./styles/global.css";

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}
